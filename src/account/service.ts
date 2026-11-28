import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { getUser, refreshServiceStats, setDisplayName } from "../files/repo";
import { Storage } from "../files/storage";
import { logEvent } from "../lib/log";

/** The two OAuth helpers deletion needs, so tests can pass a stub. */
export type GrantRevoker = Pick<OAuthHelpers, "listUserGrants" | "revokeGrant">;

export interface DeletedAccount {
  files: number;
  messages: number;
  schoolsDeleted: number;
  memberships: number;
  grants: number;
}

/**
 * Deletes an account and everything it owns (DESIGN.md "Deleting an account"):
 * 1. Its OAuth grants and their tokens, first: signing in again later gets the same user ID (the
 *    GitHub ID), so a token that outlived the account would start working again.
 * 2. In one D1 transaction: the schools where it was the only accepted member, whole; its
 *    messages in every other school, after raising each school's seq_floor to the highest seq
 *    deleted (so insertMessage never hands it out again); its other memberships and pending
 *    invites; the schools it created pass to another member; shares of other people's files
 *    with it; its files (their shares and upload parts cascade); its sessions (read positions
 *    cascade); its invite; and the `users` row last, once nothing references it.
 * 3. The R2 objects of the deleted file rows, and any unfinished multipart uploads. Reef never
 *    stored the keys, so an object a failure here leaves behind can't be read.
 *
 * Returns null if there is no such account. The day's school invite count stays (it has no
 * foreign key), so deleting and signing up again doesn't reset it.
 */
export async function deleteAccount(
  env: Env,
  oauth: GrantRevoker,
  userId: number,
): Promise<DeletedAccount | null> {
  const db = env.DB;
  const user = await getUser(db, userId);
  if (!user) return null;

  const grants = await revokeGrants(oauth, String(userId));

  const [schools, , messages, memberships, , , files] = await db.batch([
    // As when the last accepted member leaves: messages, members and positions cascade.
    db
      .prepare(
        `DELETE FROM schools
         WHERE id IN (SELECT school_id FROM school_members WHERE user_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM school_members m
             WHERE m.school_id = schools.id AND m.accepted = 1 AND m.user_id != ?1)
         RETURNING id`,
      )
      .bind(userId),
    db
      .prepare(
        `UPDATE schools SET seq_floor = MAX(seq_floor,
           (SELECT MAX(seq) FROM messages WHERE school_id = schools.id AND sender_id = ?1))
         WHERE id IN (SELECT school_id FROM messages WHERE sender_id = ?1)`,
      )
      .bind(userId),
    db.prepare("DELETE FROM messages WHERE sender_id = ?").bind(userId),
    db.prepare("DELETE FROM school_members WHERE user_id = ?").bind(userId),
    // created_by can't be null, and every school still here has an accepted member.
    db
      .prepare(
        `UPDATE schools SET created_by = (SELECT user_id FROM school_members
           WHERE school_id = schools.id ORDER BY accepted DESC, user_id LIMIT 1)
         WHERE created_by = ?`,
      )
      .bind(userId),
    db.prepare("DELETE FROM file_shares WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM files WHERE owner_id = ? RETURNING id, r2_upload_id").bind(userId),
    // In the same batch as the file delete: serviceResidentBytes relies on it.
    refreshServiceStats(db),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM invites WHERE login = ?").bind(user.login),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  const deletedFiles = (files?.results ?? []) as { id: string; r2_upload_id: string | null }[];

  const storage = new Storage(env.BUCKET);
  for (const file of deletedFiles) {
    if (file.r2_upload_id) await storage.abortMultipart(file.id, file.r2_upload_id);
  }
  await storage.delete(deletedFiles.map((f) => f.id));

  const result: DeletedAccount = {
    files: deletedFiles.length,
    messages: messages?.meta.changes ?? 0,
    schoolsDeleted: schools?.results.length ?? 0,
    memberships: memberships?.meta.changes ?? 0,
    grants,
  };
  logEvent("account.deleted", { user: userId, ...result });
  return result;
}

async function revokeGrants(oauth: GrantRevoker, userId: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { limit: 1000, cursor });
    for (const grant of page.items) {
      await oauth.revokeGrant(grant.id, userId);
      count++;
    }
    cursor = page.cursor;
  } while (cursor);
  return count;
}

/** A display name: like a GitHub login, 1 to 39 letters, digits, '-', '_' or '.', no spaces. */
const DISPLAY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,37}[A-Za-z0-9])?$/;

export type DisplayNameResult = { ok: true; name: string | null } | { ok: false; error: string };

/**
 * Sets the account's display name, or clears it when `raw` is blank. Refuses names in the wrong
 * shape and names that are another account's GitHub login or display name.
 */
export async function changeDisplayName(
  db: D1Database,
  userId: number,
  raw: string,
): Promise<DisplayNameResult> {
  const name = raw.trim().replace(/^@/, "");
  if (name === "") {
    await setDisplayName(db, userId, null);
    return { ok: true, name: null };
  }
  if (!DISPLAY_NAME.test(name))
    return {
      ok: false,
      error:
        "Use 1 to 39 letters, digits, hyphens, underscores or dots, starting and ending with a letter or digit.",
    };
  if (!(await setDisplayName(db, userId, name)))
    return { ok: false, error: "That name is taken by another Reef account. Choose another." };
  return { ok: true, name };
}
