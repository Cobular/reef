import type { SessionType } from "../config";

export type SchoolKind = "pair" | "group";

export interface SchoolRow {
  id: string;
  name: string;
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
  sender_login: string;
  session_type: SessionType;
  product: string;
  label: string;
  text: string;
  /** JSON array of StoredAttachment. */
  attachments: string;
  created_at: number;
}

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

export async function insertSchool(
  db: D1Database,
  school: SchoolRow,
  members: { userId: number; accepted: boolean }[],
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO schools (id, name, kind, paused, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        school.id,
        school.name,
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
  const [, , dropped] = await db.batch([
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
  ]);
  return (dropped?.results.length ?? 0) > 0;
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

export interface ListedMembershipRow extends MembershipRow {
  created_by_login: string | null;
  last_message_at: number | null;
  /** The furthest seq any of the account's sessions has read to (0 for none, or an invite). */
  read_seq: number;
  unread: number;
}

export interface MemberRow {
  school_id: string;
  user_id: number;
  login: string;
  accepted: number;
}

/**
 * The account's schools and invites, and every member of them, in one round trip. `read_seq` is
 * the furthest position any of the account's sessions has read to; `unread` counts messages
 * after it.
 */
export async function listMemberships(
  db: D1Database,
  userId: number,
): Promise<{ schools: ListedMembershipRow[]; members: MemberRow[] }> {
  const [schools, members] = await db.batch<ListedMembershipRow | MemberRow>([
    db
      .prepare(
        `SELECT l.*,
           CASE WHEN l.accepted = 1 THEN
             (SELECT COUNT(*) FROM messages m WHERE m.school_id = l.id AND m.seq > l.read_seq)
           ELSE 0 END AS unread
         FROM (
           SELECT sc.*, sm.accepted, sm.session_types, cu.login AS created_by_login,
             (SELECT created_at FROM messages WHERE school_id = sc.id ORDER BY seq DESC LIMIT 1)
               AS last_message_at,
             CASE WHEN sm.accepted = 1 THEN COALESCE(
               (SELECT MAX(rp.last_seq) FROM read_positions rp
                JOIN sessions s ON s.handle = rp.session_handle
                WHERE rp.school_id = sc.id AND s.user_id = ?1), 0)
             ELSE 0 END AS read_seq
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
        `SELECT sm.school_id, sm.user_id, u.login, sm.accepted FROM school_members sm
         JOIN users u ON u.id = sm.user_id
         WHERE sm.school_id IN (SELECT school_id FROM school_members WHERE user_id = ?1)
         ORDER BY u.login COLLATE NOCASE`,
      )
      .bind(userId),
  ]);
  return {
    schools: (schools?.results ?? []) as ListedMembershipRow[],
    members: (members?.results ?? []) as MemberRow[],
  };
}

/** Newest first, strictly before `beforeSeq`. */
export async function messagesBefore(
  db: D1Database,
  schoolId: string,
  beforeSeq: number,
  limit: number,
): Promise<MessageRow[]> {
  const result = await db
    .prepare(
      `SELECT m.*, u.login AS sender_login FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.school_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`,
    )
    .bind(schoolId, beforeSeq, limit)
    .all<MessageRow>();
  return result.results;
}

// ---- sessions ------------------------------------------------------------------------------

export interface RoutedSchoolRow {
  id: string;
  name: string;
  kind: SchoolKind;
  paused: number;
}

/**
 * Creates the session or refreshes its last_seen_at; the handle stays the one first issued for
 * this (account, type, product, label). Also returns the accepted schools routed to the type
 * and the number of pending invites, in the same round trip.
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
  const [session, schools, pending] = await db.batch<SessionRow | RoutedSchoolRow | { n: number }>([
    db
      .prepare(
        `INSERT INTO sessions (handle, user_id, type, product, label, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (user_id, type, product, label) DO UPDATE SET last_seen_at = excluded.last_seen_at
         RETURNING *`,
      )
      .bind(candidateHandle, userId, type, product, label, now),
    db
      .prepare(
        `SELECT sc.id, sc.name, sc.kind, sc.paused FROM school_members sm
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

/** Refreshes last_seen_at at most once an hour, so polling does not write on every call. */
function touchSession(db: D1Database, handle: string, userId: number, now: number) {
  return db
    .prepare(
      `UPDATE sessions SET last_seen_at = ?1
       WHERE handle = ?2 AND user_id = ?3 AND last_seen_at < ?1 - 3600000`,
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
           CASE WHEN sc.id IS NULL THEN 0 ELSE
             (SELECT COUNT(*) FROM messages m WHERE m.school_id = sc.id AND m.seq > COALESCE(
               (SELECT last_seq FROM read_positions
                WHERE session_handle = s.handle AND school_id = sc.id), 0))
           END AS unread
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
}

function sessionSchool(
  db: D1Database,
  handle: string,
  userId: number,
  schoolId: string,
  recentSince: number,
) {
  return db
    .prepare(
      `SELECT s.handle, s.type, s.product, s.label, sc.id AS school_id, sc.name, sc.paused,
         sm.accepted, sm.session_types,
         (SELECT COUNT(*) FROM messages WHERE sender_id = s.user_id AND created_at > ?4) AS recent
       FROM sessions s
       LEFT JOIN school_members sm ON sm.user_id = s.user_id AND sm.school_id = ?3
       LEFT JOIN schools sc ON sc.id = sm.school_id
       WHERE s.handle = ?1 AND s.user_id = ?2`,
    )
    .bind(handle, userId, schoolId, recentSince);
}

export async function getSessionSchool(
  db: D1Database,
  handle: string,
  userId: number,
  schoolId: string,
  now: number,
  recentSince: number,
): Promise<SessionSchoolRow | null> {
  const [, row] = await db.batch<SessionSchoolRow>([
    touchSession(db, handle, userId, now),
    sessionSchool(db, handle, userId, schoolId, recentSince),
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
        `SELECT m.*, u.login AS sender_login FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.school_id = ?1 AND m.seq > ${READ_POSITION} AND ${MAY_READ}
         ORDER BY m.seq LIMIT ?4`,
      )
      .bind(schoolId, handle, userId, limit),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE school_id = ?1 AND seq > ${READ_POSITION} AND ${MAY_READ}`,
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

// ---- messages ------------------------------------------------------------------------------

export interface NewMessage {
  schoolId: string;
  senderId: number;
  sessionType: SessionType;
  product: string;
  label: string;
  text: string;
  attachments: string;
  createdAt: number;
}

/**
 * Inserts a message and returns its seq, or null if a guard failed: the school is paused, the
 * sender's member row is not accepted or does not include the session type, or the sender hit
 * the rate limit. The seq is allocated inside this single INSERT ... SELECT (MAX(seq) + 1),
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
         attachments, created_at)
       SELECT ?1, COALESCE((SELECT MAX(seq) FROM messages WHERE school_id = ?1), 0) + 1,
         ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE EXISTS (SELECT 1 FROM schools WHERE id = ?1 AND paused = 0)
         AND EXISTS (SELECT 1 FROM school_members sm WHERE sm.school_id = ?1 AND sm.user_id = ?2
           AND sm.accepted = 1 AND ${typeMatch("?3")})
         AND (SELECT COUNT(*) FROM messages WHERE sender_id = ?2 AND created_at > ?9) < ?10
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
        `SELECT sm.user_id, u.login, sm.accepted FROM school_members sm
           JOIN users u ON u.id = sm.user_id
           WHERE sm.school_id = ?
           ORDER BY u.login COLLATE NOCASE`,
      )
      .bind(schoolId),
  ]);
  return {
    files: (files?.results ?? []) as AttachmentFileRow[],
    members: (members?.results ?? []) as AttachmentMemberRow[],
  };
}
