export type FileState = "pending" | "ready" | "deleted";

export interface UserRow {
  id: number;
  login: string;
  created_at: number;
  banned: number;
  /** Session cookies issued at or before this time are refused (sign-out everywhere, unban). */
  sessions_valid_after: number;
}

export interface FileRow {
  id: string;
  owner_id: number;
  name: string;
  size: number;
  state: FileState;
  r2_upload_id: string | null;
  lifetime_minutes: number;
  created_at: number;
  expires_at: number | null;
  download_limit: number | null;
  download_count: number;
  /** When the first request carrying the upload's bytes arrived; null (or absent) until then. */
  upload_started_at?: number | null;
}

export interface ListedFile extends FileRow {
  owner_login: string;
}

/** A login that names more than one active account (GitHub logins can be reused). */
export class AmbiguousLoginError extends Error {
  constructor(readonly logins: string[]) {
    super(`ambiguous logins: ${logins.join(", ")}`);
    this.name = "AmbiguousLoginError";
  }
}

// ---- users ---------------------------------------------------------------------------------

export function getUser(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function isActiveUser(db: D1Database, id: number): Promise<boolean> {
  const user = await getUser(db, id);
  return user !== null && user.banned === 0;
}

/**
 * Accounts with these logins (case-insensitive), active ones only unless `includeBanned`. Two
 * accounts can hold the same login when someone renamed on GitHub and another person took the
 * old name before the first signed in again; such a login throws AmbiguousLoginError rather than
 * picking one.
 */
export async function findUsersByLogins(
  db: D1Database,
  logins: string[],
  includeBanned = false,
): Promise<UserRow[]> {
  if (logins.length === 0) return [];
  const marks = logins.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT * FROM users WHERE login COLLATE NOCASE IN (${marks})${includeBanned ? "" : " AND banned = 0"}`,
    )
    .bind(...logins)
    .all<UserRow>();
  const byLogin = new Map<string, UserRow[]>();
  for (const u of result.results) {
    const key = u.login.toLowerCase();
    byLogin.set(key, [...(byLogin.get(key) ?? []), u]);
  }
  const ambiguous = [...byLogin.values()].filter((us) => us.length > 1).map((us) => us[0]?.login);
  if (ambiguous.length > 0) throw new AmbiguousLoginError(ambiguous as string[]);
  return result.results;
}

export async function isInvited(db: D1Database, login: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS ok FROM invites WHERE login = ?").bind(login).first();
  return row !== null;
}

export async function insertUser(db: D1Database, id: number, login: string, now: number) {
  await db
    .prepare("INSERT INTO users (id, login, created_at) VALUES (?, ?, ?)")
    .bind(id, login, now)
    .run();
}

/**
 * Inserts the account only if fewer than `cap` accounts were counted on UTC day `day`, and counts
 * it, in one transaction so two sign-ins at once can't both take the last place. The count lives
 * in signups_daily, so deleting an account doesn't give its place back. Returns false when the
 * day is full. Only for logins with no account yet.
 */
export async function insertUserCapped(
  db: D1Database,
  id: number,
  login: string,
  now: number,
  day: number,
  cap: number,
): Promise<boolean> {
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, login, created_at) SELECT ?1, ?2, ?3
         WHERE COALESCE((SELECT created FROM signups_daily WHERE day = ?4), 0) < ?5`,
      )
      .bind(id, login, now, day, cap),
    db
      .prepare(
        `INSERT INTO signups_daily (day, created)
         SELECT ?1, 1 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND created_at = ?3)
         ON CONFLICT (day) DO UPDATE SET created = created + 1`,
      )
      .bind(day, id, now),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

export async function updateUserLogin(db: D1Database, id: number, login: string) {
  await db.prepare("UPDATE users SET login = ? WHERE id = ?").bind(login, id).run();
}

// ---- files ---------------------------------------------------------------------------------

export function getFile(db: D1Database, id: string): Promise<FileRow | null> {
  return db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
}

export interface UploadCaps {
  /** UTC day (utcDay) the upload counts against. */
  day: number;
  maxPerDay: number;
  maxPending: number;
  maxAccountBytes: number;
  maxServiceBytes: number;
}

/** The service-wide resident-bytes estimate (see serviceResidentBytes), as a SQL expression. */
const SERVICE_BYTES = `(SELECT COALESCE(s.resident_bytes, 0) + COALESCE((SELECT SUM(size) FROM files
    WHERE rowid > COALESCE(s.max_file_rowid, 0) AND state != 'deleted'), 0)
  FROM (SELECT 1) LEFT JOIN service_stats s ON s.id = 1)`;

/**
 * Inserts a pending file, its share list and a count in uploads_started, in one transaction, only
 * if every upload cap still holds with this file included: uploads today, uploads in progress,
 * the account's resident bytes and the service's. Checking and inserting in one statement means
 * concurrent calls can't all pass a check that only one of them should. Returns false (and
 * writes nothing) when a cap would be exceeded.
 */
export async function insertFileCapped(
  db: D1Database,
  file: FileRow,
  shareUserIds: number[],
  caps: UploadCaps,
): Promise<boolean> {
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO files (id, owner_id, name, size, state, r2_upload_id, lifetime_minutes,
           created_at, expires_at, download_limit, download_count)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
         WHERE COALESCE((SELECT started FROM uploads_started WHERE day = ?12 AND user_id = ?2), 0) < ?13
           AND (SELECT COUNT(*) FROM files WHERE owner_id = ?2 AND state = 'pending') < ?14
           AND (SELECT COALESCE(SUM(size), 0) FROM files WHERE owner_id = ?2 AND state != 'deleted')
             + ?4 <= ?15
           AND ${SERVICE_BYTES} + ?4 <= ?16`,
      )
      .bind(
        file.id,
        file.owner_id,
        file.name,
        file.size,
        file.state,
        file.r2_upload_id,
        file.lifetime_minutes,
        file.created_at,
        file.expires_at,
        file.download_limit,
        file.download_count,
        caps.day,
        caps.maxPerDay,
        caps.maxPending,
        caps.maxAccountBytes,
        caps.maxServiceBytes,
      ),
    ...shareUserIds.map((uid) =>
      db
        .prepare(
          `INSERT INTO file_shares (file_id, user_id)
           SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM files WHERE id = ?1)`,
        )
        .bind(file.id, uid),
    ),
    db
      .prepare(
        `INSERT INTO uploads_started (day, user_id, started)
         SELECT ?1, ?2, 1 WHERE EXISTS (SELECT 1 FROM files WHERE id = ?3)
         ON CONFLICT (day, user_id) DO UPDATE SET started = started + 1`,
      )
      .bind(caps.day, file.owner_id, file.id),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

/** pending → ready. Returns the new expiry, or null if the file was no longer pending. */
export async function markReady(db: D1Database, id: string, now: number): Promise<number | null> {
  const row = await db
    .prepare(
      `UPDATE files SET state = 'ready', expires_at = ? + lifetime_minutes * 60000
       WHERE id = ? AND state = 'pending' RETURNING expires_at`,
    )
    .bind(now, id)
    .first<{ expires_at: number }>();
  return row?.expires_at ?? null;
}

/**
 * Marks a file deleted and clamps its expiry to now, so listings show when it went. This always
 * leaves expires_at set; the cleanup purge (`state = 'deleted' AND expires_at <= ?`) relies on it.
 */
export async function markDeleted(db: D1Database, ids: string[], now: number) {
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          `UPDATE files SET state = 'deleted', expires_at = MIN(COALESCE(expires_at, ?1), ?1)
           WHERE id = ?2`,
        )
        .bind(now, id),
    ),
  );
}

/**
 * Atomically counts one download. Returns false if the file is no longer ready, has expired, or
 * its download limit is used up.
 */
export async function countDownload(db: D1Database, id: string, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE files SET download_count = download_count + 1
       WHERE id = ? AND state = 'ready' AND expires_at > ?
         AND (download_limit IS NULL OR download_count < download_limit)
       RETURNING id`,
    )
    .bind(id, now)
    .first();
  return row !== null;
}

export async function canAccess(db: D1Database, file: FileRow, userId: number): Promise<boolean> {
  if (file.owner_id === userId) return true;
  const row = await db
    .prepare("SELECT 1 AS ok FROM file_shares WHERE file_id = ? AND user_id = ?")
    .bind(file.id, userId)
    .first();
  return row !== null;
}

export async function shareLogins(db: D1Database, fileId: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT u.login FROM file_shares s JOIN users u ON u.id = s.user_id
       WHERE s.file_id = ? ORDER BY u.login COLLATE NOCASE`,
    )
    .bind(fileId)
    .all<{ login: string }>();
  return result.results.map((r) => r.login);
}

export async function shareUserIds(db: D1Database, fileId: string): Promise<number[]> {
  const result = await db
    .prepare("SELECT user_id FROM file_shares WHERE file_id = ?")
    .bind(fileId)
    .all<{ user_id: number }>();
  return result.results.map((r) => r.user_id);
}

export async function setShares(db: D1Database, fileId: string, add: number[], remove: number[]) {
  const statements = [
    ...remove.map((uid) =>
      db.prepare("DELETE FROM file_shares WHERE file_id = ? AND user_id = ?").bind(fileId, uid),
    ),
    ...add.map((uid) =>
      db
        .prepare("INSERT OR IGNORE INTO file_shares (file_id, user_id) VALUES (?, ?)")
        .bind(fileId, uid),
    ),
  ];
  if (statements.length > 0) await db.batch(statements);
}

/**
 * Files the user owns or is shared on: live ones, plus those gone since `goneSince`. Another
 * account's upload that hasn't finished isn't listed to the people it's shared with.
 */
const VISIBLE_FILES = `(f.owner_id = ?1 OR (f.state != 'pending'
    AND f.id IN (SELECT file_id FROM file_shares WHERE user_id = ?1)))
  AND (f.state != 'deleted' OR COALESCE(f.expires_at, f.created_at) > ?2)`;

/**
 * 1 when the file is the user's own or its owner is an accepted member of a school the user has
 * also accepted: someone the user has agreed to hear from. Listings set other files apart, so
 * anyone with an account can't put names in front of anyone else's agent just by sharing.
 */
const KNOWN_OWNER = `(f.owner_id = ?1 OR EXISTS (SELECT 1 FROM school_members mine
    JOIN school_members theirs ON theirs.school_id = mine.school_id
    WHERE mine.user_id = ?1 AND mine.accepted = 1
      AND theirs.user_id = f.owner_id AND theirs.accepted = 1))`;

export interface ShareRow {
  file_id: string;
  user_id: number;
  login: string;
}

/**
 * The files a user can see (live ones, plus those gone since `goneSince`) and their share
 * lists, in one round trip. `known` is 0 for files from accounts the user shares no school with.
 */
export async function listFilesFor(
  db: D1Database,
  userId: number,
  goneSince: number,
): Promise<{ files: (ListedFile & { known: number })[]; shares: ShareRow[] }> {
  const [files, shares] = await db.batch<ListedFile | ShareRow>([
    db
      .prepare(
        `SELECT f.*, u.login AS owner_login, ${KNOWN_OWNER} AS known
         FROM files f JOIN users u ON u.id = f.owner_id
         WHERE ${VISIBLE_FILES}
         ORDER BY f.created_at DESC LIMIT 200`,
      )
      .bind(userId, goneSince),
    db
      .prepare(
        `SELECT s.file_id, s.user_id, u.login FROM file_shares s JOIN users u ON u.id = s.user_id
         WHERE s.file_id IN (SELECT f.id FROM files f WHERE ${VISIBLE_FILES})
         ORDER BY u.login COLLATE NOCASE`,
      )
      .bind(userId, goneSince),
  ]);
  return {
    files: (files?.results ?? []) as (ListedFile & { known: number })[],
    shares: (shares?.results ?? []) as ShareRow[],
  };
}

/** One file with its owner's login and its share list, in one round trip. */
export async function fileWithShares(
  db: D1Database,
  fileId: string,
): Promise<{ file: ListedFile | null; shares: ShareRow[] }> {
  const [file, shares] = await db.batch<ListedFile | ShareRow>([
    db
      .prepare(
        `SELECT f.*, u.login AS owner_login FROM files f JOIN users u ON u.id = f.owner_id
         WHERE f.id = ?`,
      )
      .bind(fileId),
    db
      .prepare(
        `SELECT s.file_id, s.user_id, u.login FROM file_shares s JOIN users u ON u.id = s.user_id
         WHERE s.file_id = ? ORDER BY u.login COLLATE NOCASE`,
      )
      .bind(fileId),
  ]);
  return {
    file: (file?.results[0] as ListedFile | undefined) ?? null,
    shares: (shares?.results ?? []) as ShareRow[],
  };
}

// ---- admin ---------------------------------------------------------------------------------

export interface InviteRow {
  login: string;
  created_at: number;
  /** 1 once an account with this login exists. */
  joined: number;
}

export async function listInvites(db: D1Database): Promise<InviteRow[]> {
  const result = await db
    .prepare(
      `SELECT i.login, i.created_at,
         EXISTS (SELECT 1 FROM users u WHERE u.login = i.login COLLATE NOCASE) AS joined
       FROM invites i ORDER BY i.login COLLATE NOCASE LIMIT 1000`,
    )
    .all<InviteRow>();
  return result.results;
}

/** Adds an invite; returns false if the login was already invited. */
export async function addInvite(db: D1Database, login: string, now: number): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO invites (login, created_at) VALUES (?, ?)")
    .bind(login, now)
    .run();
  return result.meta.changes > 0;
}

/** Removes an invite (case-insensitive); returns false if there was none. */
export async function removeInvite(db: D1Database, login: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM invites WHERE login = ?").bind(login).run();
  return result.meta.changes > 0;
}

export async function listUsers(db: D1Database): Promise<UserRow[]> {
  const result = await db
    .prepare("SELECT * FROM users ORDER BY login COLLATE NOCASE LIMIT 1000")
    .all<UserRow>();
  return result.results;
}

/**
 * Sets or clears the banned flag and ends the account's portal sessions, so a cookie from before
 * a ban doesn't work again after an unban. Returns the user, or null if there is no such account.
 */
export async function setBanned(
  db: D1Database,
  userId: number,
  banned: boolean,
  now: number,
): Promise<UserRow | null> {
  return db
    .prepare(
      `UPDATE users SET banned = ?, sessions_valid_after = MAX(sessions_valid_after, ?)
       WHERE id = ? RETURNING *`,
    )
    .bind(banned ? 1 : 0, now, userId)
    .first<UserRow>();
}

/** Ends every portal session the account has, in every browser. */
export async function endSessions(db: D1Database, userId: number, now: number) {
  await db
    .prepare("UPDATE users SET sessions_valid_after = MAX(sessions_valid_after, ?) WHERE id = ?")
    .bind(now, userId)
    .run();
}

// ---- quotas --------------------------------------------------------------------------------

/**
 * Bytes held by an account's files that are not deleted (pending uploads count at their
 * declared size).
 */
export async function residentBytes(db: D1Database, ownerId: number): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE state != 'deleted' AND owner_id = ?",
    )
    .bind(ownerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Bytes held by all files that are not deleted, without summing every file: service_stats as the
 * cron job last left it (refreshServiceStats), plus every file inserted since (rowid above the
 * cached maximum, a primary-key range). Never an under-count: rows are deleted only by the purge,
 * in the same batch as the refresh, so new rows get rowids above the cached maximum; a file
 * deleted since the refresh still counts until the next run.
 */
export async function serviceResidentBytes(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(s.resident_bytes, 0) + COALESCE((SELECT SUM(size) FROM files
         WHERE rowid > COALESCE(s.max_file_rowid, 0) AND state != 'deleted'), 0) AS n
       FROM (SELECT 1) LEFT JOIN service_stats s ON s.id = 1`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Recomputes service_stats; written only when a value changed. `state IN ('pending', 'ready')`
 * is the same set as `state != 'deleted'` (a CHECK constraint allows only these three), but uses
 * the files_state_expires index instead of scanning every row, deleted ones included.
 */
export function refreshServiceStats(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO service_stats (id, resident_bytes, max_file_rowid)
     SELECT 1,
       (SELECT COALESCE(SUM(size), 0) FROM files WHERE state IN ('pending', 'ready')),
       (SELECT COALESCE(MAX(rowid), 0) FROM files)
     WHERE true
     ON CONFLICT (id) DO UPDATE SET
       resident_bytes = excluded.resident_bytes, max_file_rowid = excluded.max_file_rowid
     WHERE resident_bytes != excluded.resident_bytes OR max_file_rowid != excluded.max_file_rowid`,
  );
}

/** Uploads the account has started on UTC day `day` (uploads_started; survives deletions). */
export async function uploadsOnDay(db: D1Database, ownerId: number, day: number) {
  const row = await db
    .prepare("SELECT started FROM uploads_started WHERE day = ? AND user_id = ?")
    .bind(day, ownerId)
    .first<{ started: number }>();
  return row?.started ?? 0;
}

/** The account's uploads still in progress. */
export async function pendingUploads(db: D1Database, ownerId: number) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM files WHERE owner_id = ? AND state = 'pending'")
    .bind(ownerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Records that the first request carrying an upload's bytes arrived. Returns false if the file
 * is no longer pending (the cron job may have swept it).
 */
export async function markUploadStarted(db: D1Database, id: string, now: number) {
  const result = await db
    .prepare(
      `UPDATE files SET upload_started_at = COALESCE(upload_started_at, ?)
       WHERE id = ? AND state = 'pending'`,
    )
    .bind(now, id)
    .run();
  return result.meta.changes > 0;
}

/** Notes that an account had a counted download of a file, so it may resume with ranges. */
export async function recordDownload(db: D1Database, fileId: string, userId: number) {
  await db
    .prepare("INSERT OR IGNORE INTO download_receipts (file_id, user_id) VALUES (?, ?)")
    .bind(fileId, userId)
    .run();
}

export async function hasDownloaded(db: D1Database, fileId: string, userId: number) {
  const row = await db
    .prepare("SELECT 1 AS ok FROM download_receipts WHERE file_id = ? AND user_id = ?")
    .bind(fileId, userId)
    .first();
  return row !== null;
}

// ---- upload parts --------------------------------------------------------------------------

export async function recordPart(
  db: D1Database,
  fileId: string,
  partNumber: number,
  etag: string,
  now: number,
) {
  await db
    .prepare(
      `INSERT INTO upload_parts (file_id, part_number, etag, uploaded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (file_id, part_number) DO UPDATE SET etag = excluded.etag,
         uploaded_at = excluded.uploaded_at`,
    )
    .bind(fileId, partNumber, etag, now)
    .run();
}

export async function listParts(db: D1Database, fileId: string): Promise<R2UploadedPart[]> {
  const result = await db
    .prepare(
      `SELECT part_number AS partNumber, etag FROM upload_parts
       WHERE file_id = ? ORDER BY part_number`,
    )
    .bind(fileId)
    .all<R2UploadedPart>();
  return result.results;
}

export async function deleteParts(db: D1Database, fileId: string) {
  await db.prepare("DELETE FROM upload_parts WHERE file_id = ?").bind(fileId).run();
}
