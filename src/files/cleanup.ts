import { ROW_RETENTION_MS, UPLOAD_TOKEN_TTL_MS } from "../config";
import { logEvent } from "../lib/log";
import { markDeleted, refreshServiceStats } from "./repo";
import { Storage } from "./storage";

/** Uploads still pending this long after creation can no longer finish (their token expired). */
export const STALE_UPLOAD_MS = UPLOAD_TOKEN_TTL_MS + 5 * 60 * 1000;

const BATCH = 500;

export interface CleanupResult {
  expired: number;
  abandoned: number;
  purged: number;
}

/**
 * The 5-minute cron job (DESIGN.md "Expiry"): delete expired objects, abort uploads that never
 * finished, mark their rows deleted, and purge rows (and part receipts) 24 hours after expiry.
 */
export async function cleanup(env: Env, now = Date.now()): Promise<CleanupResult> {
  const db = env.DB;
  const storage = new Storage(env.BUCKET);

  const expired = await db
    .prepare(
      "SELECT id FROM files WHERE state = 'ready' AND expires_at <= ? ORDER BY expires_at LIMIT ?",
    )
    .bind(now, BATCH)
    .all<{ id: string }>();
  const expiredIds = expired.results.map((r) => r.id);
  if (expiredIds.length > 0) {
    await storage.delete(expiredIds);
    await markDeleted(db, expiredIds, now);
  }

  const stale = await db
    .prepare(
      // Pending rows are only the uploads in flight, so the (state, expires_at) index's state
      // prefix is enough; no index on created_at is kept for this.
      "SELECT id, r2_upload_id FROM files WHERE state = 'pending' AND created_at <= ? LIMIT ?",
    )
    .bind(now - STALE_UPLOAD_MS, BATCH)
    .all<{ id: string; r2_upload_id: string | null }>();
  for (const row of stale.results) {
    if (row.r2_upload_id) await storage.abortMultipart(row.id, row.r2_upload_id);
  }
  const staleIds = stale.results.map((r) => r.id);
  if (staleIds.length > 0) {
    // A single PUT may have stored bytes without the row reaching `ready`.
    await storage.delete(staleIds);
    await markDeleted(db, staleIds, now);
  }

  const [, purged] = await db.batch([
    db.prepare(
      `DELETE FROM upload_parts
       WHERE file_id NOT IN (SELECT id FROM files WHERE state = 'pending')`,
    ),
    // markDeleted always sets expires_at, so this matches the rows COALESCE(expires_at,
    // created_at) would, while using the (state, expires_at) index range.
    db
      .prepare("DELETE FROM files WHERE state = 'deleted' AND expires_at <= ?")
      .bind(now - ROW_RETENTION_MS),
    // After the purge: serviceResidentBytes relies on no file row being deleted between two
    // refreshes.
    refreshServiceStats(db),
  ]);
  const result = {
    expired: expiredIds.length,
    abandoned: staleIds.length,
    purged: purged?.meta.changes ?? 0,
  };
  logEvent("cron.cleanup", { ...result });
  return result;
}
