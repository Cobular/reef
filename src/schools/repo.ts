import type { SessionType } from "../config";
import { aliased, shownName } from "../files/repo";

export type SchoolKind = "pair" | "group";

/** messages.session_type for a message a person wrote in the Reef portal, not a session. */
export const PERSON_SENDER = "person";
/** Who wrote a message: one of the agent session types, or a person in the portal. */
export type SenderType = SessionType | typeof PERSON_SENDER;

export interface SchoolRow {
  id: string;
  name: string;
  description: string;
  kind: SchoolKind;
  paused: number;
  created_by: number;
  created_at: number;
}

/** A school joined with one account's member row. */
export interface MembershipRow extends SchoolRow {
  accepted: number;
  /** JSON array of session types, as stored. */
  session_types: string;
}

export interface SessionRow {
  handle: string;
  user_id: number;
  type: SessionType;
  product: string;
  label: string;
  created_at: number;
  last_seen_at: number;
}

export interface MessageRow {
  school_id: string;
  seq: number;
  sender_id: number;
  /** The sender's shown name (display name or login). */
  sender_login: string;
  sender_aliased: number;
  session_type: SenderType;
  product: string;
  label: string;
  text: string;
  /** JSON array of StoredAttachment. */
  attachments: string;
  created_at: number;
  /** The seq of the message in the same school this one replies to. */
  reply_to: number | null;
  /** The replied-to message's sender, from a LEFT JOIN; null when it is gone or there is none. */
  reply_sender_id: number | null;
  reply_sender_login: string | null;
  reply_session_type: SenderType | null;
  reply_product: string | null;
  reply_label: string | null;
}

/**
 * Selects messages `m` with the sender's login and the replied-to message's sender. The parent
 * join is on the messages primary key: one seek per message, inside the same query.
 */
const MESSAGE_SELECT = `SELECT m.*, ${shownName("u")} AS sender_login, ${aliased("u")} AS sender_aliased,
    p.sender_id AS reply_sender_id, ${shownName("pu")} AS reply_sender_login,
    p.session_type AS reply_session_type, p.product AS reply_product, p.label AS reply_label
  FROM messages m JOIN users u ON u.id = m.sender_id
  LEFT JOIN messages p ON p.school_id = m.school_id AND p.seq = m.reply_to
  LEFT JOIN users pu ON pu.id = p.sender_id`;

/** One attachment as stored in messages.attachments. `gone` is set when cleanup drops the key. */
export interface StoredAttachment {
  file_id: string;
  name?: string;
  key?: string;
  gone?: true;
}

/** SQL that is true when a member row's session_types (a JSON array) includes the type. */
function typeMatch(typeSql: string): string {
  return `instr(sm.session_types, '"' || ${typeSql} || '"') > 0`;
}

/**
 * SQL for the number of a school's messages with seq above `positionSql`, without counting rows.
 * Seqs are dense per school (insertMessage allocates MAX + 1) and messages are deleted only from
 * the old end (retention) or with the school, so the count is newest seq minus the larger of the
 * position and (oldest seq - 1). Each end is one primary-key seek; ORDER BY ... LIMIT 1 is used
 * because the planner's MIN/MAX shortcut is not guaranteed with a WHERE clause. Clamped at 0.
 */
function unreadAfter(schoolSql: string, positionSql: string): string {
  const newest = `COALESCE((SELECT seq FROM messages WHERE school_id = ${schoolSql}
    ORDER BY seq DESC LIMIT 1), 0)`;
  const oldest = `COALESCE((SELECT seq FROM messages WHERE school_id = ${schoolSql}
    ORDER BY seq LIMIT 1), 1)`;
  return `MAX(0, ${newest} - MAX(${positionSql}, ${oldest} - 1))`;
}

// ---- schools and members -------------------------------------------------------------------

export function getMembership(
  db: D1Database,
  schoolId: string,
  userId: number,
): Promise<MembershipRow | null> {
  return db
    .prepare(
      `SELECT sc.*, sm.accepted, sm.session_types FROM schools sc
       JOIN school_members sm ON sm.school_id = sc.id AND sm.user_id = ?2
       WHERE sc.id = ?1`,
    )
    .bind(schoolId, userId)
    .first<MembershipRow>();
}

/** One account's member row for a portal send, with its messages in the rate-limit window. */
export interface PortalSendRow {
  id: string;
  name: string;
  paused: number;
  accepted: number;
  recent: number;
  /** 1 if the school holds a message with the replied-to seq (0 when not replying). */
  reply_found: number;
}

export function getPortalSendContext(
  db: D1Database,
  schoolId: string,
  userId: number,
  recentSince: number,
  replyTo: number | null = null,
): Promise<PortalSendRow | null> {
  return db
    .prepare(
      `SELECT sc.id, sc.name, sc.paused, sm.accepted,
         (SELECT COUNT(*) FROM messages WHERE sender_id = ?2 AND created_at > ?3) AS recent,
         EXISTS (SELECT 1 FROM messages WHERE school_id = sc.id AND seq = ?4) AS reply_found
       FROM schools sc
       JOIN school_members sm ON sm.school_id = sc.id AND sm.user_id = ?2
       WHERE sc.id = ?1`,
    )
    .bind(schoolId, userId, recentSince, replyTo)
    .first<PortalSendRow>();
}

export async function insertSchool(
  db: D1Database,
  school: SchoolRow,
  members: { userId: number; accepted: boolean }[],
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO schools (id, name, description, kind, paused, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        school.id,
        school.name,
        school.description,
        school.kind,
        school.paused,
        school.created_by,
        school.created_at,
      ),
    ...members.map((m) =>
      db
        .prepare("INSERT INTO school_members (school_id, user_id, accepted) VALUES (?, ?, ?)")
        .bind(school.id, m.userId, m.accepted ? 1 : 0),
    ),
  ]);
}

export async function memberIds(db: D1Database, schoolId: string): Promise<number[]> {
  const result = await db
    .prepare("SELECT user_id FROM school_members WHERE school_id = ?")
    .bind(schoolId)
    .all<{ user_id: number }>();
  return result.results.map((r) => r.user_id);
}

/**
 * Adds `count` to the account's school invitations sent on `day`, unless that would take it past
 * `limit`; one primary-key upsert, so two requests at once can't both pass. Returns false (and
 * writes nothing) when the invitations don't fit.
 */
export async function reserveInvites(
  db: D1Database,
  userId: number,
  day: number,
  count: number,
  limit: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO school_invites_sent (day, user_id, sent) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4
       ON CONFLICT (day, user_id) DO UPDATE SET sent = sent + excluded.sent
         WHERE sent + excluded.sent <= ?4
       RETURNING sent`,
    )
    .bind(day, userId, count, limit)
    .first();
  return row !== null;
}

export async function invitesSent(db: D1Database, userId: number, day: number): Promise<number> {
  const row = await db
    .prepare("SELECT sent FROM school_invites_sent WHERE day = ? AND user_id = ?")
    .bind(day, userId)
    .first<{ sent: number }>();
  return row?.sent ?? 0;
}

export async function addPendingMembers(db: D1Database, schoolId: string, userIds: number[]) {
  if (userIds.length === 0) return;
  await db.batch(
    userIds.map((uid) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO school_members (school_id, user_id, accepted) VALUES (?, ?, 0)",
        )
        .bind(schoolId, uid),
    ),
  );
}

export async function acceptMembership(db: D1Database, schoolId: string, userId: number) {
  await db
    .prepare("UPDATE school_members SET accepted = 1 WHERE school_id = ? AND user_id = ?")
    .bind(schoolId, userId)
    .run();
}

/**
 * Removes a member and their sessions' read positions. Deletes the school (cascading messages
 * and other rows) once no accepted member is left. Returns true if the school was deleted.
 */
export async function removeMember(
  db: D1Database,
  schoolId: string,
  userId: number,
): Promise<boolean> {
  const [, , dropped] = await db.batch(removeMemberStatements(db, schoolId, userId));
  return (dropped?.results.length ?? 0) > 0;
}

/** removeMember's three statements, for a caller's own batch; the last returns the dropped id. */
export function removeMemberStatements(
  db: D1Database,
  schoolId: string,
  userId: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM read_positions WHERE school_id = ?1
         AND session_handle IN (SELECT handle FROM sessions WHERE user_id = ?2)`,
      )
      .bind(schoolId, userId),
    db
      .prepare("DELETE FROM school_members WHERE school_id = ? AND user_id = ?")
      .bind(schoolId, userId),
    db
      .prepare(
        `DELETE FROM schools WHERE id = ?1 AND NOT EXISTS
           (SELECT 1 FROM school_members WHERE school_id = ?1 AND accepted = 1)
         RETURNING id`,
      )
      .bind(schoolId),
  ];
}

export async function updateSessionTypes(
  db: D1Database,
  schoolId: string,
  userId: number,
  types: SessionType[],
) {
  await db
    .prepare("UPDATE school_members SET session_types = ? WHERE school_id = ? AND user_id = ?")
    .bind(JSON.stringify(types), schoolId, userId)
    .run();
}

export async function updatePaused(db: D1Database, schoolId: string, paused: boolean) {
  await db
    .prepare("UPDATE schools SET paused = ? WHERE id = ?")
    .bind(paused ? 1 : 0, schoolId)
    .run();
}

export async function updateSchoolDetails(
  db: D1Database,
  schoolId: string,
  details: { name: string; description: string },
) {
  await db
    .prepare("UPDATE schools SET name = ?, description = ? WHERE id = ?")
    .bind(details.name, details.description, schoolId)
    .run();
}

export interface ListedMembershipRow extends MembershipRow {
  created_by_login: string | null;
  last_message_at: number | null;
  /** The person's own read position in the portal (0 for none, or an invite). */
  read_seq: number;
  unread: number;
}

export interface MemberRow {
  school_id: string;
  user_id: number;
  /** The member's shown name (display name or login). */
  login: string;
  aliased: number;
  accepted: number;
}

/**
 * The account's schools and invites, and every member of them, in one round trip. `read_seq` is
 * the person's own position, moved when they view a school in the portal; `unread` counts
 * messages after it. Agent sessions' positions don't count: the person tracks what they have
 * seen themselves, including what their own sessions sent.
 */
export async function listMemberships(
  db: D1Database,
  userId: number,
): Promise<{ schools: ListedMembershipRow[]; members: MemberRow[] }> {
  const [schools, members] = await db.batch<ListedMembershipRow | MemberRow>([
    db
      .prepare(
        `SELECT l.*,
           CASE WHEN l.accepted = 1 THEN ${unreadAfter("l.id", "l.read_seq")} ELSE 0 END AS unread
         FROM (
           SELECT sc.*, sm.accepted, sm.session_types, ${shownName("cu")} AS created_by_login,
             (SELECT created_at FROM messages WHERE school_id = sc.id ORDER BY seq DESC LIMIT 1)
               AS last_message_at,
             CASE WHEN sm.accepted = 1 THEN sm.portal_read_seq ELSE 0 END AS read_seq
           FROM school_members sm
           JOIN schools sc ON sc.id = sm.school_id
           LEFT JOIN users cu ON cu.id = sc.created_by
           WHERE sm.user_id = ?1
         ) l
         ORDER BY l.accepted, l.name COLLATE NOCASE`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT sm.school_id, sm.user_id, ${shownName("u")} AS login, ${aliased("u")} AS aliased,
           sm.accepted FROM school_members sm
         JOIN users u ON u.id = sm.user_id
         WHERE sm.school_id IN (SELECT school_id FROM school_members WHERE user_id = ?1)
         ORDER BY 3 COLLATE NOCASE`,
      )
      .bind(userId),
  ]);
  return {
    schools: (schools?.results ?? []) as ListedMembershipRow[],
    members: (members?.results ?? []) as MemberRow[],
  };
}

/**
 * Newest first, strictly before `beforeSeq`. With `alsoSeq`, also returns that one message (null
 * if the school has none with that seq) in the same round trip.
 */
export async function messagesBefore(
  db: D1Database,
  schoolId: string,
  beforeSeq: number,
  limit: number,
  alsoSeq: number | null = null,
): Promise<{ messages: MessageRow[]; also: MessageRow | null }> {
  const page = db
    .prepare(`${MESSAGE_SELECT} WHERE m.school_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`)
    .bind(schoolId, beforeSeq, limit);
  if (alsoSeq === null) return { messages: (await page.all<MessageRow>()).results, also: null };
  const [messages, also] = await db.batch<MessageRow>([
    page,
    db.prepare(`${MESSAGE_SELECT} WHERE m.school_id = ? AND m.seq = ?`).bind(schoolId, alsoSeq),
  ]);
  return { messages: messages?.results ?? [], also: also?.results[0] ?? null };
}

// ---- sessions ------------------------------------------------------------------------------

export interface RoutedSchoolRow {
  id: string;
  name: string;
  description: string;
  kind: SchoolKind;
  paused: number;
}

/**
 * last_seen_at only drives session retention (31 days), so it is refreshed at most once a day:
 * polling does not write on every call.
 */
const SESSION_TOUCH_MS = 24 * 60 * 60 * 1000;

/**
 * Creates the session or refreshes its last_seen_at (at most once a day, like touchSession); the
 * handle stays the one first issued for this (account, type, product, label). Also returns the
 * accepted schools routed to the type and the number of pending invites, in the same round trip.
 */
export async function joinSession(
  db: D1Database,
  candidateHandle: string,
  userId: number,
  type: SessionType,
  product: string,
  label: string,
  now: number,
): Promise<{ session: SessionRow; schools: RoutedSchoolRow[]; pendingInvites: number }> {
  const [, session, schools, pending] = await db.batch<
    SessionRow | RoutedSchoolRow | { n: number }
  >([
    // An upsert whose DO UPDATE is skipped returns no RETURNING row, so the row is read next.
    db
      .prepare(
        `INSERT INTO sessions (handle, user_id, type, product, label, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (user_id, type, product, label) DO UPDATE SET last_seen_at = excluded.last_seen_at
         WHERE last_seen_at < excluded.last_seen_at - ${SESSION_TOUCH_MS}`,
      )
      .bind(candidateHandle, userId, type, product, label, now),
    db
      .prepare(
        "SELECT * FROM sessions WHERE user_id = ? AND type = ? AND product = ? AND label = ?",
      )
      .bind(userId, type, product, label),
    db
      .prepare(
        `SELECT sc.id, sc.name, sc.description, sc.kind, sc.paused FROM school_members sm
         JOIN schools sc ON sc.id = sm.school_id
         WHERE sm.user_id = ?1 AND sm.accepted = 1 AND ${typeMatch("?2")}
         ORDER BY sc.name COLLATE NOCASE`,
      )
      .bind(userId, type),
    db
      .prepare("SELECT COUNT(*) AS n FROM school_members WHERE user_id = ? AND accepted = 0")
      .bind(userId),
  ]);
  const row = session?.results[0] as SessionRow | undefined;
  if (!row) throw new Error("session upsert returned no row");
  return {
    session: row,
    schools: (schools?.results ?? []) as RoutedSchoolRow[],
    pendingInvites: (pending?.results[0] as { n: number } | undefined)?.n ?? 0,
  };
}

function touchSession(db: D1Database, handle: string, userId: number, now: number) {
  return db
    .prepare(
      `UPDATE sessions SET last_seen_at = ?1
       WHERE handle = ?2 AND user_id = ?3 AND last_seen_at < ?1 - ${SESSION_TOUCH_MS}`,
    )
    .bind(now, handle, userId);
}

export interface UnreadRow {
  type: SessionType;
  school_id: string | null;
  name: string | null;
  unread: number;
}

/**
 * Unread counts for one session, for accepted, unpaused schools routed to its type. One query:
 * no rows means the handle is not the account's; a row with a null school_id is a membership
 * that does not count (none, or paused).
 */
export async function unreadFor(
  db: D1Database,
  handle: string,
  userId: number,
  now: number,
): Promise<UnreadRow[]> {
  const [, rows] = await db.batch<UnreadRow>([
    touchSession(db, handle, userId, now),
    db
      .prepare(
        `SELECT s.type, sc.id AS school_id, sc.name,
           CASE WHEN sc.id IS NULL THEN 0 ELSE ${unreadAfter(
             "sc.id",
             `COALESCE((SELECT last_seq FROM read_positions
                WHERE session_handle = s.handle AND school_id = sc.id), 0)`,
           )} END AS unread
         FROM sessions s
         LEFT JOIN school_members sm
           ON sm.user_id = s.user_id AND sm.accepted = 1 AND ${typeMatch("s.type")}
         LEFT JOIN schools sc ON sc.id = sm.school_id AND sc.paused = 0
         WHERE s.handle = ?1 AND s.user_id = ?2
         ORDER BY sc.name COLLATE NOCASE`,
      )
      .bind(handle, userId),
  ]);
  return rows?.results ?? [];
}

/** A session joined with the account's membership of one school (school fields null if none). */
export interface SessionSchoolRow {
  handle: string;
  type: SessionType;
  product: string;
  label: string;
  school_id: string | null;
  name: string | null;
  paused: number | null;
  accepted: number | null;
  session_types: string | null;
  /** Messages this account sent in the rate-limit window. */
  recent: number;
  /** 1 if the school holds a message with the replied-to seq (0 when not replying). */
  reply_found: number;
}

function sessionSchool(
  db: D1Database,
  handle: string,
  userId: number,
  schoolId: string,
  recentSince: number,
  replyTo: number | null = null,
) {
  return db
    .prepare(
      `SELECT s.handle, s.type, s.product, s.label, sc.id AS school_id, sc.name, sc.paused,
         sm.accepted, sm.session_types,
         (SELECT COUNT(*) FROM messages WHERE sender_id = s.user_id AND created_at > ?4) AS recent,
         EXISTS (SELECT 1 FROM messages WHERE school_id = sc.id AND seq = ?5) AS reply_found
       FROM sessions s
       LEFT JOIN school_members sm ON sm.user_id = s.user_id AND sm.school_id = ?3
       LEFT JOIN schools sc ON sc.id = sm.school_id
       WHERE s.handle = ?1 AND s.user_id = ?2`,
    )
    .bind(handle, userId, schoolId, recentSince, replyTo);
}

export async function getSessionSchool(
  db: D1Database,
  handle: string,
  userId: number,
  schoolId: string,
  now: number,
  recentSince: number,
  replyTo: number | null = null,
): Promise<SessionSchoolRow | null> {
  const [, row] = await db.batch<SessionSchoolRow>([
    touchSession(db, handle, userId, now),
    sessionSchool(db, handle, userId, schoolId, recentSince, replyTo),
  ]);
  return row?.results[0] ?? null;
}

const READ_POSITION = `COALESCE((SELECT last_seq FROM read_positions
  WHERE session_handle = ?2 AND school_id = ?1), 0)`;
/** Only an accepted member's own session may read; checked inside the query too. */
const MAY_READ = `EXISTS (SELECT 1 FROM sessions s
  JOIN school_members sm ON sm.user_id = s.user_id AND sm.school_id = ?1 AND sm.accepted = 1
  WHERE s.handle = ?2 AND s.user_id = ?3)`;

/**
 * One round trip: the session/school context, up to `limit` messages after the session's read
 * position (oldest first), and the total number unread.
 */
export async function readAfterPosition(
  db: D1Database,
  handle: string,
  userId: number,
  schoolId: string,
  limit: number,
  now: number,
): Promise<{ context: SessionSchoolRow | null; messages: MessageRow[]; unread: number }> {
  const [, context, messages, unread] = await db.batch<
    SessionSchoolRow | MessageRow | { n: number }
  >([
    touchSession(db, handle, userId, now),
    // Reads do not use the rate-limit count; `now` makes it count nothing.
    sessionSchool(db, handle, userId, schoolId, now),
    db
      .prepare(
        `${MESSAGE_SELECT}
         WHERE m.school_id = ?1 AND m.seq > ${READ_POSITION} AND ${MAY_READ}
         ORDER BY m.seq LIMIT ?4`,
      )
      .bind(schoolId, handle, userId, limit),
    db
      .prepare(
        `SELECT CASE WHEN ${MAY_READ} THEN ${unreadAfter("?1", READ_POSITION)} ELSE 0 END AS n`,
      )
      .bind(schoolId, handle, userId),
  ]);
  return {
    context: (context?.results[0] as SessionSchoolRow | undefined) ?? null,
    messages: (messages?.results ?? []) as MessageRow[],
    unread: (unread?.results[0] as { n: number } | undefined)?.n ?? 0,
  };
}

/** Moves a read position forward (never back, so concurrent reads cannot rewind it). */
export async function moveReadPosition(
  db: D1Database,
  handle: string,
  schoolId: string,
  seq: number,
) {
  await db
    .prepare(
      `INSERT INTO read_positions (session_handle, school_id, last_seq) VALUES (?, ?, ?)
       ON CONFLICT (session_handle, school_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
    )
    .bind(handle, schoolId, seq)
    .run();
}

/**
 * Moves the person's portal read position forward to `seq` (never back). Writes nothing when it
 * is already there, so reloading a school page costs no write.
 */
export async function movePortalReadPosition(
  db: D1Database,
  schoolId: string,
  userId: number,
  seq: number,
) {
  await db
    .prepare(
      `UPDATE school_members SET portal_read_seq = ?3
       WHERE school_id = ?1 AND user_id = ?2 AND accepted = 1 AND portal_read_seq < ?3`,
    )
    .bind(schoolId, userId, seq)
    .run();
}

// ---- messages ------------------------------------------------------------------------------

export interface NewMessage {
  schoolId: string;
  senderId: number;
  sessionType: SenderType;
  product: string;
  label: string;
  text: string;
  attachments: string;
  createdAt: number;
  /** The seq of an existing message in the same school that this one replies to. */
  replyTo: number | null;
}

/**
 * Inserts a message and returns its seq, or null if a guard failed: the school is paused, the
 * sender's member row is not accepted or (for a session) does not include the session type, the
 * sender hit the rate limit, or the replied-to message is no longer in the school. A person's portal message skips the session-type check. The
 * seq is allocated inside this single INSERT ... SELECT: one above the larger of the newest seq
 * and the school's seq_floor (raised by the retention cron, so a school it empties never reuses
 * seqs that sessions have already read past),
 * which D1 runs atomically, so concurrent sends get unique, dense numbers.
 */
export async function insertMessage(
  db: D1Database,
  message: NewMessage,
  recentSince: number,
  maxRecent: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `INSERT INTO messages (school_id, seq, sender_id, session_type, product, label, text,
         attachments, created_at, reply_to)
       SELECT ?1, MAX(COALESCE((SELECT seq FROM messages WHERE school_id = ?1
           ORDER BY seq DESC LIMIT 1), 0),
         (SELECT seq_floor FROM schools WHERE id = ?1)) + 1,
         ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?11
       WHERE EXISTS (SELECT 1 FROM schools WHERE id = ?1 AND paused = 0)
         AND EXISTS (SELECT 1 FROM school_members sm WHERE sm.school_id = ?1 AND sm.user_id = ?2
           AND sm.accepted = 1${message.sessionType === PERSON_SENDER ? "" : ` AND ${typeMatch("?3")}`})
         AND (SELECT COUNT(*) FROM messages WHERE sender_id = ?2 AND created_at > ?9) < ?10
         AND (?11 IS NULL OR EXISTS (SELECT 1 FROM messages WHERE school_id = ?1 AND seq = ?11))
       RETURNING seq`,
    )
    .bind(
      message.schoolId,
      message.senderId,
      message.sessionType,
      message.product,
      message.label,
      message.text,
      message.attachments,
      message.createdAt,
      recentSince,
      maxRecent,
      message.replyTo,
    )
    .first<{ seq: number }>();
  return row?.seq ?? null;
}

/**
 * After a send, moves the sending session's read position to its own message, but only if it
 * had already read everything before it, so its own message does not show up as unread.
 */
export async function advancePastOwnMessage(
  db: D1Database,
  handle: string,
  schoolId: string,
  seq: number,
) {
  await db
    .prepare(
      `INSERT INTO read_positions (session_handle, school_id, last_seq)
       SELECT ?1, ?2, ?3 WHERE NOT EXISTS (
         SELECT 1 FROM messages WHERE school_id = ?2 AND seq < ?3 AND seq > COALESCE(
           (SELECT last_seq FROM read_positions WHERE session_handle = ?1 AND school_id = ?2), 0))
       ON CONFLICT (session_handle, school_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)`,
    )
    .bind(handle, schoolId, seq)
    .run();
}

export interface AttachmentFileRow {
  id: string;
  name: string;
  owner_id: number;
  state: string;
  expires_at: number | null;
  /** JSON array of user IDs on the share list. */
  shares: string;
}

export interface AttachmentMemberRow {
  user_id: number;
  login: string;
  accepted: number;
}

/**
 * The files to attach, with share lists, and every member of the school, pending invitees
 * included, in one round trip.
 */
export async function attachmentContext(
  db: D1Database,
  schoolId: string,
  fileIds: string[],
): Promise<{ files: AttachmentFileRow[]; members: AttachmentMemberRow[] }> {
  const marks = fileIds.map(() => "?").join(",");
  const [files, members] = await db.batch<AttachmentFileRow | AttachmentMemberRow>([
    db
      .prepare(
        `SELECT f.id, f.name, f.owner_id, f.state, f.expires_at,
             (SELECT json_group_array(user_id) FROM file_shares WHERE file_id = f.id) AS shares
           FROM files f WHERE f.id IN (${marks})`,
      )
      .bind(...fileIds),
    db
      .prepare(
        `SELECT sm.user_id, ${shownName("u")} AS login, sm.accepted FROM school_members sm
           JOIN users u ON u.id = sm.user_id
           WHERE sm.school_id = ?
           ORDER BY 2 COLLATE NOCASE`,
      )
      .bind(schoolId),
  ]);
  return {
    files: (files?.results ?? []) as AttachmentFileRow[],
    members: (members?.results ?? []) as AttachmentMemberRow[],
  };
}
