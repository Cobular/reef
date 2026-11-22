export type FileState = "pending" | "ready" | "deleted";

export interface UserRow {
  id: number;
  login: string;
  created_at: number;
  banned: number;
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
  owner_login: string;
}

// ---- users ---------------------------------------------------------------------------------

export function getUser(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function isActiveUser(db: D1Database, id: number): Promise<boolean> {
  const user = await getUser(db, id);
  return user !== null && user.banned === 0;
}

export async function findUsersByLogins(db: D1Database, logins: string[]): Promise<UserRow[]> {
  if (logins.length === 0) return [];
  const marks = logins.map(() => "?").join(",");
  const result = await db
    .prepare(`SELECT * FROM users WHERE login COLLATE NOCASE IN (${marks})`)
    .bind(...logins)
    .all<UserRow>();
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

/** Marks a file deleted and clamps its expiry to now, so listings show when it went. */
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

/** Files the user owns or is shared on: live ones, plus those gone in the last `sinceMs`. */
export async function listFilesFor(
  db: D1Database,
  userId: number,
  goneSince: number,
): Promise<ListedFile[]> {
  const result = await db
    .prepare(
      `SELECT f.*, u.login AS owner_login FROM files f JOIN users u ON u.id = f.owner_id
       WHERE (f.owner_id = ?1 OR f.id IN (SELECT file_id FROM file_shares WHERE user_id = ?1))
         AND (f.state != 'deleted' OR COALESCE(f.expires_at, f.created_at) > ?2)
       ORDER BY f.created_at DESC LIMIT 200`,
    )
    .bind(userId, goneSince)
    .all<ListedFile>();
  return result.results;
}

// ---- quotas --------------------------------------------------------------------------------

/** Bytes held by files that are not deleted (pending uploads count at their declared size). */
export async function residentBytes(db: D1Database, ownerId?: number): Promise<number> {
  const stmt =
    ownerId === undefined
      ? db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE state != 'deleted'")
      : db
          .prepare(
            "SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE state != 'deleted' AND owner_id = ?",
          )
          .bind(ownerId);
  return (await stmt.first<{ n: number }>())?.n ?? 0;
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
