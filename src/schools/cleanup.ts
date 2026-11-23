import { SCHOOL_LIMITS } from "../config";
import { logEvent } from "../lib/log";
import type { StoredAttachment } from "./repo";

const BATCH = 1000;

export interface SchoolCleanupResult {
  messages: number;
  blanked: number;
  sessions: number;
}

/**
 * Messages that still carry a key for a file that has expired, been deleted, or been purged,
 * with the IDs of those files. The instr() test must match the partial index messages_keyed
 * (migrations/0002_schools.sql).
 */
const KEYED_GONE = `
  SELECT school_id, seq, attachments, gone FROM (
    SELECT m.school_id, m.seq, m.attachments,
      (SELECT json_group_array(json_extract(a.value, '$.file_id')) FROM json_each(m.attachments) a
       LEFT JOIN files f ON f.id = json_extract(a.value, '$.file_id')
       WHERE json_extract(a.value, '$.key') IS NOT NULL
         AND (f.id IS NULL OR f.state = 'deleted' OR f.expires_at <= ?1)) AS gone
    FROM messages m WHERE instr(m.attachments, '"key"') > 0
  ) WHERE gone <> '[]' LIMIT ?2`;

/**
 * Schools whose oldest message is past retention, with their oldest and newest seqs. CROSS JOIN
 * keeps schools as the outer loop (otherwise the planner scans every message); each subquery is
 * one primary-key seek (ORDER BY ... LIMIT 1 rather than MIN/MAX, as in src/schools/repo.ts
 * unreadAfter).
 */
const EXPIRED_SCHOOLS = `
  SELECT sc.id, m.seq AS oldest,
    (SELECT seq FROM messages WHERE school_id = sc.id ORDER BY seq DESC LIMIT 1) AS newest
  FROM schools sc
  CROSS JOIN messages m ON m.school_id = sc.id
    AND m.seq = (SELECT seq FROM messages WHERE school_id = sc.id ORDER BY seq LIMIT 1)
  WHERE m.created_at <= ?1 LIMIT ?2`;

/**
 * Deletes a school's oldest messages, up to the first one still inside retention and at most
 * BATCH of them (?2 is the oldest seq plus BATCH). Retention only ever removes a prefix of a
 * school's seqs, so "messages after my read position" stays a plain seq range; a message that
 * was created out of order by a few milliseconds waits for the next run. Both scans walk the
 * primary key.
 */
const DELETE_PREFIX = `
  DELETE FROM messages WHERE school_id = ?1 AND seq < COALESCE(
    (SELECT seq FROM messages WHERE school_id = ?1 AND seq < ?2 AND created_at > ?3
     ORDER BY seq LIMIT 1), ?2)`;

/**
 * Raises seq_floor to the highest seq just deleted: one below the school's oldest remaining
 * message or, once the school is empty, its newest seq when the run started (?2). insertMessage
 * then never hands out a seq again that a session may already have read past
 * (migrations/0007_seq_floor.sql). A message sent since the run started is inside retention, so
 * it is never deleted and the school is not empty.
 */
const RAISE_FLOOR = `
  UPDATE schools SET seq_floor = MAX(seq_floor, COALESCE(
    (SELECT seq FROM messages WHERE school_id = ?1 ORDER BY seq LIMIT 1) - 1, ?2))
  WHERE id = ?1`;

/** At most this many schools have messages deleted per run, each at most BATCH of them. */
const RETENTION_SCHOOLS = 10;

export interface SchoolCleanupOptions {
  /**
   * Whether to run message retention. It scans every school, so the cron job runs it once an
   * hour rather than every five minutes; messages are kept for 30 days either way.
   */
  messages?: boolean;
}

/**
 * The schools part of the cron job: delete messages past retention, remove attachment keys
 * once their file is gone, and delete sessions not seen for 31 days (read positions cascade).
 * Each step handles a bounded number of rows per run; the next run picks up the rest.
 */
export async function cleanupSchools(
  db: D1Database,
  now: number,
  options: SchoolCleanupOptions = {},
): Promise<SchoolCleanupResult> {
  const messages = options.messages === false ? 0 : await deleteExpiredMessages(db, now);
  const [sessions, keyed] = await db.batch<{
    school_id: string;
    seq: number;
    attachments: string;
    gone: string;
  }>([
    db
      .prepare(
        `DELETE FROM sessions WHERE handle IN
           (SELECT handle FROM sessions WHERE last_seen_at <= ? LIMIT ?)`,
      )
      .bind(now - SCHOOL_LIMITS.sessionRetentionMs, BATCH),
    db.prepare(KEYED_GONE).bind(now, BATCH),
  ]);

  const updates: D1PreparedStatement[] = [];
  for (const row of keyed?.results ?? []) {
    const gone = new Set(JSON.parse(row.gone) as string[]);
    const attachments = (JSON.parse(row.attachments) as StoredAttachment[]).map((a) => {
      if (a.key === undefined || !gone.has(a.file_id)) return a;
      const { key: _removed, ...rest } = a;
      return { ...rest, gone: true as const };
    });
    updates.push(
      db
        .prepare("UPDATE messages SET attachments = ? WHERE school_id = ? AND seq = ?")
        .bind(JSON.stringify(attachments), row.school_id, row.seq),
    );
  }
  if (updates.length > 0) await db.batch(updates);

  const result = {
    messages,
    blanked: updates.length,
    // D1 counts cascaded rows (read positions) in `changes` for the session delete.
    sessions: sessions?.meta.changes ?? 0,
  };
  logEvent("cron.schools_cleanup", { ...result });
  return result;
}

async function deleteExpiredMessages(db: D1Database, now: number): Promise<number> {
  const cutoff = now - SCHOOL_LIMITS.messageRetentionMs;
  const { results: schools } = await db
    .prepare(EXPIRED_SCHOOLS)
    .bind(cutoff, RETENTION_SCHOOLS)
    .all<{ id: string; oldest: number; newest: number }>();
  if (schools.length === 0) return 0;
  const statements = schools.flatMap((school) => [
    db.prepare(DELETE_PREFIX).bind(school.id, school.oldest + BATCH, cutoff),
    db.prepare(RAISE_FLOOR).bind(school.id, school.newest),
  ]);
  const results = await db.batch(statements);
  return results.reduce((sum, r, i) => (i % 2 === 0 ? sum + (r.meta.changes ?? 0) : sum), 0);
}
