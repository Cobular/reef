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
 * The schools part of the cron job: delete messages past retention, remove attachment keys
 * once their file is gone, and delete sessions not seen for 90 days (read positions cascade).
 * Each step handles at most BATCH rows per run; the next run picks up the rest.
 */
export async function cleanupSchools(db: D1Database, now: number): Promise<SchoolCleanupResult> {
  const [messages, sessions, keyed] = await db.batch<{
    school_id: string;
    seq: number;
    attachments: string;
    gone: string;
  }>([
    db
      .prepare(
        `DELETE FROM messages WHERE rowid IN
           (SELECT rowid FROM messages WHERE created_at <= ? LIMIT ?)`,
      )
      .bind(now - SCHOOL_LIMITS.messageRetentionMs, BATCH),
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
    // D1 counts cascaded rows (read positions) in `changes` for the session delete.
    messages: messages?.meta.changes ?? 0,
    blanked: updates.length,
    sessions: sessions?.meta.changes ?? 0,
  };
  logEvent("cron.schools_cleanup", { ...result });
  return result;
}
