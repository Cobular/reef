export type FileState = "pending" | "ready" | "deleted";

export interface UserRow {
  id: number;
  login: string;
  /** The name Reef shows instead of the login, if the account chose one. */
  display_name: string | null;
  created_at: number;
  banned: number;
}

/**
 * SQL for the name Reef shows for the account in table alias `u`: its display name if it chose
 * one, else its GitHub login. Columns that carry it keep "login" in their names (sender_login,
 * owner_login, ...) for brevity; their values are this shown name.
 */
export function shownName(u: string): string {
  return `COALESCE(${u}.display_name, ${u}.login)`;
}

/** SQL that is 1 when the account in alias `u` chose a display name (so hide its GitHub face). */
export function aliased(u: string): string {
  return `(${u}.display_name IS NOT NULL)`;
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
}

export interface ListedFile extends FileRow {
  /** The owner's shown name (display name or login). */
  owner_login: string;
  owner_aliased: number;
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
 * The accounts named, by GitHub login or display name (case-insensitive). A name that is one
 * account's login and another's display name resolves to the login: logins are canonical.
 * Returns each named account once, keyed by the name as given (lowercased).
 */
export async function findUsersByNames(
  db: D1Database,
  names: string[],
): Promise<Map<string, UserRow>> {
  const found = new Map<string, UserRow>();
  if (names.length === 0) return found;
  const marks = names.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT * FROM users WHERE login COLLATE NOCASE IN (${marks})
         OR display_name COLLATE NOCASE IN (${marks})`,
    )
    .bind(...names, ...names)
    .all<UserRow>();
  for (const name of names) {
    const key = name.toLowerCase();
    const byLogin = result.results.find((u) => u.login.toLowerCase() === key);
    const byName = result.results.find((u) => u.display_name?.toLowerCase() === key);
    const user = byLogin ?? byName;
    if (user) found.set(key, user);
  }
  return found;
}

/**
 * Sets (or with null, clears) the account's display name. Returns false, writing nothing, when
 * the name is another account's login or display name (case-insensitive).
 */
export async function setDisplayName(
  db: D1Database,
  id: number,
  name: string | null,
): Promise<boolean> {
  try {
    const result = await db
      .prepare(
        `UPDATE users SET display_name = ?2 WHERE id = ?1 AND (?2 IS NULL OR NOT EXISTS (
           SELECT 1 FROM users WHERE id != ?1
             AND (login = ?2 COLLATE NOCASE OR display_name = ?2 COLLATE NOCASE)))`,
      )
      .bind(id, name)
      .run();
    return result.meta.changes > 0;
  } catch (error) {
    // Two accounts claiming the same name at once: the unique index refuses the second.
    if (String(error).includes("UNIQUE")) return false;
    throw error;
  }
}

/**
 * A login takes precedence over a display name: clears any other account's display name equal
 * to it. Run when an account is created or its login changes.
 */
export async function releaseDisplayName(db: D1Database, id: number, login: string) {
  await db
    .prepare(
      "UPDATE users SET display_name = NULL WHERE display_name = ?2 COLLATE NOCASE AND id != ?1",
    )
    .bind(id, login)
    .run();
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
 * Inserts the account only if fewer than `cap` accounts were created since `since`, in one
 * statement so two sign-ins at once can't both take the last place. The count stops at `cap`
 * rows of the users_created index. Returns false when the day is full.
 */
export async function insertUserCapped(
  db: D1Database,
  id: number,
  login: string,
  now: number,
  since: number,
  cap: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO users (id, login, created_at) SELECT ?1, ?2, ?3
       WHERE (SELECT COUNT(*) FROM (SELECT 1 FROM users WHERE created_at >= ?4 LIMIT ?5)) < ?5`,
    )
    .bind(id, login, now, since, cap)
    .run();
  return result.meta.changes > 0;
}

export async function updateUserLogin(db: D1Database, id: number, login: string) {
  await db.prepare("UPDATE users SET login = ? WHERE id = ?").bind(login, id).run();
}

// ---- files ---------------------------------------------------------------------------------

export function getFile(db: D1Database, id: string): Promise<FileRow | null> {
  return db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
}

export async function insertFile(db: D1Database, file: FileRow, shareUserIds: number[]) {
  const statements = [
    db
      .prepare(
        `INSERT INTO files (id, owner_id, name, size, state, r2_upload_id, lifetime_minutes,
           created_at, expires_at, download_limit, download_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ),
    ...shareUserIds.map((uid) =>
      db.prepare("INSERT INTO file_shares (file_id, user_id) VALUES (?, ?)").bind(file.id, uid),
    ),
  ];
  await db.batch(statements);
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
      `SELECT ${shownName("u")} AS login FROM file_shares s JOIN users u ON u.id = s.user_id
       WHERE s.file_id = ? ORDER BY 1 COLLATE NOCASE`,
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

/** Files the user owns or is shared on: live ones, plus those gone since `goneSince`. */
const VISIBLE_FILES = `(f.owner_id = ?1 OR f.id IN (SELECT file_id FROM file_shares WHERE user_id = ?1))
  AND (f.state != 'deleted' OR COALESCE(f.expires_at, f.created_at) > ?2)`;

export interface ShareRow {
  file_id: string;
  user_id: number;
  /** The account's shown name (display name or login). */
  login: string;
  aliased: number;
}

/**
 * The files a user can see (live ones, plus those gone since `goneSince`) and their share
 * lists, in one round trip.
 */
export async function listFilesFor(
  db: D1Database,
  userId: number,
  goneSince: number,
): Promise<{ files: ListedFile[]; shares: ShareRow[] }> {
  const [files, shares] = await db.batch<ListedFile | ShareRow>([
    db
      .prepare(
        `SELECT f.*, ${shownName("u")} AS owner_login, ${aliased("u")} AS owner_aliased
           FROM files f JOIN users u ON u.id = f.owner_id
         WHERE ${VISIBLE_FILES}
         ORDER BY f.created_at DESC LIMIT 200`,
      )
      .bind(userId, goneSince),
    db
      .prepare(
        `SELECT s.file_id, s.user_id, ${shownName("u")} AS login, ${aliased("u")} AS aliased
           FROM file_shares s JOIN users u ON u.id = s.user_id
         WHERE s.file_id IN (SELECT f.id FROM files f WHERE ${VISIBLE_FILES})
         ORDER BY 3 COLLATE NOCASE`,
      )
      .bind(userId, goneSince),
  ]);
  return {
    files: (files?.results ?? []) as ListedFile[],
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
        `SELECT f.*, ${shownName("u")} AS owner_login, ${aliased("u")} AS owner_aliased
           FROM files f JOIN users u ON u.id = f.owner_id
         WHERE f.id = ?`,
      )
      .bind(fileId),
    db
      .prepare(
        `SELECT s.file_id, s.user_id, ${shownName("u")} AS login, ${aliased("u")} AS aliased
           FROM file_shares s JOIN users u ON u.id = s.user_id
         WHERE s.file_id = ? ORDER BY 3 COLLATE NOCASE`,
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

/** Sets or clears the banned flag; returns the user, or null if there is no such account. */
export async function setBanned(
  db: D1Database,
  userId: number,
  banned: boolean,
): Promise<UserRow | null> {
  return db
    .prepare("UPDATE users SET banned = ? WHERE id = ? RETURNING *")
    .bind(banned ? 1 : 0, userId)
    .first<UserRow>();
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

export async function uploadsSince(db: D1Database, ownerId: number, since: number) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM files WHERE owner_id = ? AND created_at > ?")
    .bind(ownerId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
