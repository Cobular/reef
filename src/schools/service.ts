import { SCHOOL_LIMITS, SESSION_TYPES, type SessionType } from "../config";
import { isValidKey } from "../files/key";
import { findUsersByLogins, type UserRow } from "../files/repo";
import { ReefError, uniqueLogins } from "../files/service";
import { utf8 } from "../lib/base64";
import { randomId } from "../lib/crypto";
import { logEvent } from "../lib/log";
import type { MessageRow, SchoolKind, SchoolRow, SessionSchoolRow, StoredAttachment } from "./repo";
import * as repo from "./repo";

/**
 * Schools: chat rooms between agent sessions (DESIGN.md "Schools"). Every function takes the
 * acting account's user ID and checks permissions itself, so the MCP tools and the portal can
 * share this layer. A school the actor is not a member of looks exactly like a missing one.
 */

export interface SchoolsContext {
  db: D1Database;
  now: number;
}

export function schoolsContext(env: Env, now = Date.now()): SchoolsContext {
  return { db: env.DB, now };
}

const ID_PATTERN = /^[a-z0-9]{1,64}$/;
const CONTROL_CHAR = /\p{Cc}/u;
const RATE_WINDOW_MS = 60_000;
const HANDLE_LENGTH = 24;

function noSuchSchool(schoolId: string): ReefError {
  return new ReefError(404, `No school ${schoolId.slice(0, 64)} that you are a member of.`);
}

function noSuchSession(handle: string): ReefError {
  return new ReefError(
    404,
    `No session ${handle.slice(0, 64)} on your account. Call session_join to get a handle.`,
  );
}

function schoolRef(school: { id: string; name: string | null }): string {
  return `"${school.name ?? ""}" (${school.id})`;
}

function isSessionType(value: unknown): value is SessionType {
  return (SESSION_TYPES as readonly unknown[]).includes(value);
}

/** Parses a member row's session_types; anything unreadable counts as no types. */
export function parseSessionTypes(json: string | null): SessionType[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter(isSessionType) : [];
  } catch {
    return [];
  }
}

function textField(field: string, value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max)
    throw new ReefError(400, `${field} must be 1 to ${max} characters`);
  if (CONTROL_CHAR.test(trimmed))
    throw new ReefError(400, `${field} must be one line without control characters`);
  return trimmed;
}

// ---- schools -------------------------------------------------------------------------------

async function membershipOf(ctx: SchoolsContext, actor: number, schoolId: string) {
  const row = ID_PATTERN.test(schoolId) ? await repo.getMembership(ctx.db, schoolId, actor) : null;
  if (!row) throw noSuchSchool(schoolId);
  return row;
}

async function acceptedMembershipOf(ctx: SchoolsContext, actor: number, schoolId: string) {
  const row = await membershipOf(ctx, actor, schoolId);
  if (row.accepted !== 1)
    throw new ReefError(403, `Accept the invite to school ${schoolRef(row)} first.`);
  return row;
}

/** Resolves logins to active accounts other than the actor; refuses unknown or banned ones. */
async function resolveInvitees(
  ctx: SchoolsContext,
  actor: number,
  logins: string[],
): Promise<UserRow[]> {
  const wanted = uniqueLogins(logins);
  const users = (await findUsersByLogins(ctx.db, wanted)).filter((u) => u.banned === 0);
  const found = new Set(users.map((u) => u.login.toLowerCase()));
  const missing = wanted.filter((l) => !found.has(l.toLowerCase()));
  if (missing.length > 0)
    throw new ReefError(
      400,
      `Not Reef accounts: ${missing.join(", ")}. Only people who have signed in to Reef can be invited.`,
    );
  const byId = new Map(users.filter((u) => u.id !== actor).map((u) => [u.id, u]));
  return [...byId.values()];
}

function capacity(kind: SchoolKind): number {
  return kind === "pair" ? 2 : SCHOOL_LIMITS.maxGroupMembers;
}

export interface CreatedSchool {
  school: SchoolRow;
  invited: string[];
}

/**
 * Creates a school with the actor as its first accepted member. A pair has exactly one other
 * account; a group has up to 20 members in all, and may have none besides the actor (the "all
 * my sessions" school). Invitees join with accepted = 0.
 */
export async function createSchool(
  ctx: SchoolsContext,
  actor: number,
  name: string,
  kind: SchoolKind,
  inviteLogins: string[] = [],
): Promise<CreatedSchool> {
  const schoolName = textField("name", name, SCHOOL_LIMITS.maxSchoolNameLength);
  if (kind !== "pair" && kind !== "group") throw new ReefError(400, "kind must be pair or group");
  const invitees = await resolveInvitees(ctx, actor, inviteLogins);
  if (kind === "pair" && invitees.length !== 1)
    throw new ReefError(400, "A pair school has exactly one other account.");
  if (invitees.length + 1 > capacity(kind))
    throw new ReefError(400, `A group school has at most ${capacity(kind)} members.`);
  const school: SchoolRow = {
    id: randomId(),
    name: schoolName,
    kind,
    paused: 0,
    created_by: actor,
    created_at: ctx.now,
  };
  await repo.insertSchool(ctx.db, school, [
    { userId: actor, accepted: true },
    ...invitees.map((u) => ({ userId: u.id, accepted: false })),
  ]);
  logEvent("school.created", { school: school.id, user: actor, kind, invited: invitees.length });
  return { school, invited: invitees.map((u) => u.login) };
}

/** Invites more accounts. Any accepted member may invite, up to the school's capacity. */
export async function inviteToSchool(
  ctx: SchoolsContext,
  actor: number,
  schoolId: string,
  logins: string[],
): Promise<{ invited: string[] }> {
  const school = await acceptedMembershipOf(ctx, actor, schoolId);
  const invitees = await resolveInvitees(ctx, actor, logins);
  const current = new Set(await repo.memberIds(ctx.db, school.id));
  const fresh = invitees.filter((u) => !current.has(u.id));
  if (current.size + fresh.length > capacity(school.kind))
    throw new ReefError(
      400,
      school.kind === "pair"
        ? "A pair school has exactly two members."
        : `A group school has at most ${capacity(school.kind)} members.`,
    );
  await repo.addPendingMembers(
    ctx.db,
    school.id,
    fresh.map((u) => u.id),
  );
  logEvent("school.invited", { school: school.id, user: actor, invited: fresh.length });
  return { invited: fresh.map((u) => u.login) };
}

export async function acceptInvite(ctx: SchoolsContext, actor: number, schoolId: string) {
  const row = await membershipOf(ctx, actor, schoolId);
  if (row.accepted !== 1) {
    await repo.acceptMembership(ctx.db, row.id, actor);
    logEvent("school.accepted", { school: row.id, user: actor });
  }
}

/** Declines a pending invite. The school goes if no accepted member is left. */
export async function declineInvite(
  ctx: SchoolsContext,
  actor: number,
  schoolId: string,
): Promise<{ schoolDeleted: boolean }> {
  const row = await membershipOf(ctx, actor, schoolId);
  if (row.accepted === 1)
    throw new ReefError(
      409,
      `You are already a member of school ${schoolRef(row)}. Leave it instead.`,
    );
  const schoolDeleted = await repo.removeMember(ctx.db, row.id, actor);
  logEvent("school.declined", { school: row.id, user: actor, deleted: schoolDeleted });
  return { schoolDeleted };
}

/**
 * Leaves a school. When the last accepted member leaves, the school and its messages are
 * deleted, along with any invites still pending.
 */
export async function leaveSchool(
  ctx: SchoolsContext,
  actor: number,
  schoolId: string,
): Promise<{ schoolDeleted: boolean }> {
  const row = await membershipOf(ctx, actor, schoolId);
  const schoolDeleted = await repo.removeMember(ctx.db, row.id, actor);
  logEvent("school.left", { school: row.id, user: actor, deleted: schoolDeleted });
  return { schoolDeleted };
}

/** Sets which of the actor's own session types take part. A routing filter, not a boundary. */
export async function setSessionTypes(
  ctx: SchoolsContext,
  actor: number,
  schoolId: string,
  types: string[],
): Promise<SessionType[]> {
  const row = await membershipOf(ctx, actor, schoolId);
  const bad = types.filter((t) => !isSessionType(t));
  if (bad.length > 0)
    throw new ReefError(
      400,
      `Unknown session types: ${bad.join(", ")}. Use ${SESSION_TYPES.join(", ")}.`,
    );
  const chosen = SESSION_TYPES.filter((t) => types.includes(t));
  await repo.updateSessionTypes(ctx.db, row.id, actor, chosen);
  return chosen;
}

async function setPaused(ctx: SchoolsContext, actor: number, schoolId: string, paused: boolean) {
  const row = await acceptedMembershipOf(ctx, actor, schoolId);
  await repo.updatePaused(ctx.db, row.id, paused);
  logEvent(paused ? "school.paused" : "school.resumed", { school: row.id, user: actor });
}

/** Stops all sends in the school at once. Any accepted member may pause or resume. */
export function pauseSchool(ctx: SchoolsContext, actor: number, schoolId: string) {
  return setPaused(ctx, actor, schoolId, true);
}

export function resumeSchool(ctx: SchoolsContext, actor: number, schoolId: string) {
  return setPaused(ctx, actor, schoolId, false);
}

export interface SchoolListing {
  id: string;
  name: string;
  kind: SchoolKind;
  paused: boolean;
  createdBy: string | null;
  /** False for a pending invite. */
  accepted: boolean;
  /** The actor's own session types taking part. */
  sessionTypes: SessionType[];
  members: { id: number; login: string; accepted: boolean }[];
  lastMessageAt: number | null;
  /** The furthest seq any of the actor's sessions has read to; 0 if none has read any. */
  readSeq: number;
  /** Messages after the furthest point any of the actor's sessions has read to. */
  unread: number;
}

/** The actor's schools and pending invites (invites first), with members and unread counts. */
export async function listSchoolsFor(ctx: SchoolsContext, actor: number): Promise<SchoolListing[]> {
  const { schools, members } = await repo.listMemberships(ctx.db, actor);
  const bySchool = new Map<string, SchoolListing["members"]>();
  for (const m of members) {
    let list = bySchool.get(m.school_id);
    if (!list) {
      list = [];
      bySchool.set(m.school_id, list);
    }
    list.push({ id: m.user_id, login: m.login, accepted: m.accepted === 1 });
  }
  return schools.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    paused: s.paused === 1,
    createdBy: s.created_by_login,
    accepted: s.accepted === 1,
    sessionTypes: parseSessionTypes(s.session_types),
    members: bySchool.get(s.id) ?? [],
    lastMessageAt: s.last_message_at,
    readSeq: s.read_seq,
    unread: s.unread,
  }));
}

// ---- messages as returned ------------------------------------------------------------------

export type MessageOrigin = "this_session" | "own_account" | "other_account";

export interface AttachmentView {
  fileId: string;
  name: string | null;
  key: string | null;
  /** The file expired or was deleted, and cleanup removed the key. */
  gone: boolean;
}

export interface MessageView {
  seq: number;
  createdAt: number;
  sender: { id: number; login: string };
  sessionType: SessionType;
  product: string;
  label: string;
  text: string;
  attachments: AttachmentView[];
  origin: MessageOrigin;
}

function parseAttachments(json: string): AttachmentView[] {
  if (json === "[]") return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return (value as StoredAttachment[]).map((a) => ({
      fileId: String(a.file_id),
      name: a.name ?? null,
      key: a.key ?? null,
      gone: a.gone === true,
    }));
  } catch {
    return [];
  }
}

function messageView(
  row: MessageRow,
  actor: number,
  session?: { type: string; product: string; label: string },
): MessageView {
  let origin: MessageOrigin = "other_account";
  if (row.sender_id === actor) {
    origin =
      session &&
      row.session_type === session.type &&
      row.product === session.product &&
      row.label === session.label
        ? "this_session"
        : "own_account";
  }
  return {
    seq: row.seq,
    createdAt: row.created_at,
    sender: { id: row.sender_id, login: row.sender_login },
    sessionType: row.session_type,
    product: row.product,
    label: row.label,
    text: row.text,
    attachments: parseAttachments(row.attachments),
    origin,
  };
}

export interface TranscriptPage {
  school: SchoolRow;
  /** Newest first. */
  messages: MessageView[];
  /** Pass as `before` for the next (older) page; null when there is none. */
  nextBefore: number | null;
}

/** A page of a school's messages, newest first, for accepted members. Moves no read position. */
export async function transcript(
  ctx: SchoolsContext,
  actor: number,
  schoolId: string,
  options: { before?: number; limit?: number } = {},
): Promise<TranscriptPage> {
  const row = await acceptedMembershipOf(ctx, actor, schoolId);
  const limit = readLimit(options.limit);
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const rows = await repo.messagesBefore(ctx.db, row.id, before, limit + 1);
  const page = withinPageBudget(rows.slice(0, limit));
  const { accepted: _a, session_types: _t, ...school } = row;
  return {
    school,
    messages: page.map((m) => messageView(m, actor)),
    nextBefore: rows.length > page.length ? (page[page.length - 1]?.seq ?? null) : null,
  };
}

/** The longest prefix of `rows` within the page text budget, never fewer than one row. */
function withinPageBudget<T extends { text: string; attachments: string }>(rows: T[]): T[] {
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as T;
    used += row.text.length + row.attachments.length;
    if (used > SCHOOL_LIMITS.maxPageChars && i > 0) return rows.slice(0, i);
  }
  return rows;
}

function readLimit(limit: number | undefined): number {
  const value = limit ?? SCHOOL_LIMITS.defaultReadLimit;
  if (!Number.isInteger(value) || value < 1 || value > SCHOOL_LIMITS.maxReadLimit)
    throw new ReefError(400, `limit must be 1 to ${SCHOOL_LIMITS.maxReadLimit}`);
  return value;
}

// ---- sessions ------------------------------------------------------------------------------

export interface RoutedSchool {
  id: string;
  name: string;
  kind: SchoolKind;
}

export interface JoinedSession {
  handle: string;
  type: SessionType;
  product: string;
  label: string;
  /** Accepted, unpaused schools whose member settings include this session type. */
  open: RoutedSchool[];
  /** As `open`, but paused: readable, not sendable. */
  paused: RoutedSchool[];
  pendingInvites: number;
}

/**
 * Registers the session, or finds it again. The handle is random, and the same for every join
 * with the same account, type, product and label, so a session can rejoin and keep its place.
 */
export async function joinSession(
  ctx: SchoolsContext,
  actor: number,
  type: string,
  label: string,
  product: string,
): Promise<JoinedSession> {
  if (!isSessionType(type))
    throw new ReefError(400, `type must be one of ${SESSION_TYPES.join(", ")}`);
  const cleanLabel = textField("label", label, SCHOOL_LIMITS.maxLabelLength);
  const cleanProduct = textField("product", product, SCHOOL_LIMITS.maxProductLength);
  const { session, schools, pendingInvites } = await repo.joinSession(
    ctx.db,
    randomId(HANDLE_LENGTH),
    actor,
    type,
    cleanProduct,
    cleanLabel,
    ctx.now,
  );
  const toRef = (s: repo.RoutedSchoolRow) => ({ id: s.id, name: s.name, kind: s.kind });
  return {
    handle: session.handle,
    type: session.type,
    product: session.product,
    label: session.label,
    open: schools.filter((s) => s.paused === 0).map(toRef),
    paused: schools.filter((s) => s.paused === 1).map(toRef),
    pendingInvites,
  };
}

function checkHandle(handle: string): void {
  if (handle.length !== HANDLE_LENGTH || !ID_PATTERN.test(handle)) throw noSuchSession(handle);
}

export interface UnreadSummary {
  type: SessionType;
  any: boolean;
  schools: { id: string; name: string; unread: number }[];
}

/** Unread counts for one session, over the unpaused schools open to its type. One query. */
export async function checkUnread(
  ctx: SchoolsContext,
  actor: number,
  handle: string,
): Promise<UnreadSummary> {
  checkHandle(handle);
  const rows = await repo.unreadFor(ctx.db, handle, actor, ctx.now);
  const first = rows[0];
  if (!first) throw noSuchSession(handle);
  const schools: UnreadSummary["schools"] = [];
  for (const r of rows) {
    if (r.school_id !== null)
      schools.push({ id: r.school_id, name: r.name ?? "", unread: r.unread });
  }
  return { type: first.type, any: schools.some((s) => s.unread > 0), schools };
}

/** Resolves the handle and the school for a session, refusing in the order a person would fix. */
function requireSessionSchool(
  row: SessionSchoolRow | null,
  handle: string,
  schoolId: string,
): SessionSchoolRow & { school_id: string } {
  if (!row) throw noSuchSession(handle);
  if (row.school_id === null) throw noSuchSchool(schoolId);
  if (row.accepted !== 1)
    throw new ReefError(
      403,
      `You have not accepted the invite to school ${schoolRef({ id: row.school_id, name: row.name })}. Your user can accept it in the Reef portal.`,
    );
  return row as SessionSchoolRow & { school_id: string };
}

export interface ReadResult {
  school: { id: string; name: string; paused: boolean };
  /** Oldest first. */
  messages: MessageView[];
  /** Unread messages still waiting after these. */
  remaining: number;
}

/**
 * Returns messages after this session's read position, oldest first, and moves the position to
 * the last one returned. Other sessions, including the account's own, keep their own positions.
 */
export async function readMessages(
  ctx: SchoolsContext,
  actor: number,
  handle: string,
  schoolId: string,
  limit?: number,
): Promise<ReadResult> {
  checkHandle(handle);
  const count = readLimit(limit);
  if (!ID_PATTERN.test(schoolId)) throw noSuchSchool(schoolId);
  const result = await repo.readAfterPosition(ctx.db, handle, actor, schoolId, count, ctx.now);
  const row = requireSessionSchool(result.context, handle, schoolId);
  const messages = withinPageBudget(result.messages);
  const last = messages[messages.length - 1];
  if (last) await repo.moveReadPosition(ctx.db, handle, row.school_id, last.seq);
  return {
    school: { id: row.school_id, name: row.name ?? "", paused: row.paused === 1 },
    messages: messages.map((m) => messageView(m, actor, row)),
    remaining: Math.max(0, result.unread - messages.length),
  };
}

/** Throws the refusal a send would get, if any. */
function assertCanSend(
  row: SessionSchoolRow | null,
  handle: string,
  schoolId: string,
): SessionSchoolRow & { school_id: string } {
  const ok = requireSessionSchool(row, handle, schoolId);
  const ref = schoolRef({ id: ok.school_id, name: ok.name });
  if (ok.paused === 1)
    throw new ReefError(
      409,
      `School ${ref} is paused, so no messages can be sent. Any member can resume it in the Reef portal.`,
    );
  if (!parseSessionTypes(ok.session_types).includes(ok.type))
    throw new ReefError(
      403,
      `Session type ${ok.type} does not take part in school ${ref}. Your user can change which session types take part in the Reef portal.`,
    );
  if (ok.recent >= SCHOOL_LIMITS.maxMessagesPerAccountPerMinute)
    throw new ReefError(
      429,
      `Message limit reached: ${SCHOOL_LIMITS.maxMessagesPerAccountPerMinute} messages per account per minute. Wait a minute, then send again.`,
    );
  return ok;
}

export interface AttachmentInput {
  file_id: string;
  key?: string | undefined;
}

function checkText(text: string): void {
  const max = SCHOOL_LIMITS.maxMessageBytes;
  if (text.length === 0) throw new ReefError(400, "text must not be empty");
  // UTF-8 never uses fewer bytes than UTF-16 code units, so a long string fails before encoding.
  const bytes = text.length > max ? text.length : utf8(text).length;
  if (bytes > max)
    throw new ReefError(
      413,
      `Message too long: the limit is ${max} bytes of UTF-8 text. Split it, or upload it as a file with create_upload and attach it.`,
    );
}

function checkAttachmentShape(attachments: AttachmentInput[]): void {
  if (attachments.length > SCHOOL_LIMITS.maxAttachments)
    throw new ReefError(400, `A message carries at most ${SCHOOL_LIMITS.maxAttachments} files.`);
  for (const a of attachments) {
    if (!ID_PATTERN.test(a.file_id))
      throw new ReefError(404, `No file ${a.file_id.slice(0, 64)} that you own or are shared on.`);
    if (a.key !== undefined && !isValidKey(a.key))
      throw new ReefError(
        400,
        `The key for file ${a.file_id} must be 32 random bytes, base64-encoded.`,
      );
  }
}

/**
 * Checks each attached file exists, is live, and is the sender's to pass on, and that every
 * other member, pending invitees included, is already on its share list: an invitee who
 * accepts later reads the same message. Reef does not share files on its own.
 */
async function storedAttachments(
  ctx: SchoolsContext,
  actor: number,
  school: { school_id: string; name: string | null },
  attachments: AttachmentInput[],
): Promise<StoredAttachment[]> {
  const ids = [...new Set(attachments.map((a) => a.file_id))];
  const { files, members } = await repo.attachmentContext(ctx.db, school.school_id, ids);
  const byId = new Map(files.map((f) => [f.id, f]));
  return attachments.map((a) => {
    const file = byId.get(a.file_id);
    const shares = file ? (JSON.parse(file.shares) as number[]) : [];
    if (!file || (file.owner_id !== actor && !shares.includes(actor)))
      throw new ReefError(404, `No file ${a.file_id} that you own or are shared on.`);
    if (file.state === "deleted" || (file.expires_at !== null && file.expires_at <= ctx.now))
      throw new ReefError(410, `File ${file.id} has expired or been deleted.`);
    const missing = members
      .filter((m) => m.user_id !== file.owner_id && !shares.includes(m.user_id))
      .map((m) => (m.accepted === 1 ? m.login : `${m.login} (invited)`));
    if (missing.length > 0)
      throw new ReefError(
        403,
        `Not every member of school ${schoolRef({ id: school.school_id, name: school.name })} can fetch file ${file.id} (${file.name}). Not on its share list: ${missing.join(", ")}. The file's owner can add them with share_file; then send again.`,
      );
    return a.key === undefined
      ? { file_id: file.id, name: file.name }
      : { file_id: file.id, name: file.name, key: a.key.trim() };
  });
}

/** Sends a message and returns its per-school sequence number. */
export async function sendMessage(
  ctx: SchoolsContext,
  actor: number,
  handle: string,
  schoolId: string,
  text: string,
  attachments: AttachmentInput[] = [],
): Promise<{ seq: number; school: { id: string; name: string } }> {
  checkHandle(handle);
  checkText(text);
  checkAttachmentShape(attachments);
  if (!ID_PATTERN.test(schoolId)) throw noSuchSchool(schoolId);
  const since = ctx.now - RATE_WINDOW_MS;
  const load = () => repo.getSessionSchool(ctx.db, handle, actor, schoolId, ctx.now, since);
  const row = assertCanSend(await load(), handle, schoolId);
  const stored =
    attachments.length > 0 ? await storedAttachments(ctx, actor, row, attachments) : [];
  const seq = await repo.insertMessage(
    ctx.db,
    {
      schoolId: row.school_id,
      senderId: actor,
      sessionType: row.type,
      product: row.product,
      label: row.label,
      text,
      attachments: stored.length > 0 ? JSON.stringify(stored) : "[]",
      createdAt: ctx.now,
    },
    since,
    SCHOOL_LIMITS.maxMessagesPerAccountPerMinute,
  );
  if (seq === null) {
    // Something changed between the check and the insert (a pause, a race to the rate limit).
    assertCanSend(await load(), handle, schoolId);
    throw new ReefError(409, "The message was not sent. Try again.");
  }
  await repo.advancePastOwnMessage(ctx.db, handle, row.school_id, seq);
  logEvent("school.message", {
    school: row.school_id,
    user: actor,
    seq,
    files: stored.length,
  });
  return { seq, school: { id: row.school_id, name: row.name ?? "" } };
}
