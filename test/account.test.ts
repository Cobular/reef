import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteAccount, type GrantRevoker } from "../src/account/service";
import { addInvite, serviceResidentBytes } from "../src/files/repo";
import { createUpload, filesContext } from "../src/files/service";
import { objectKey } from "../src/files/storage";
import {
  acceptInvite,
  checkUnread,
  createSchool,
  joinSession,
  leaveSchool,
  readMessages,
  schoolsContext,
  sendMessage,
  transcript,
} from "../src/schools/service";
import { addUser, resetDb, ssecBucket, TEST_PART_SIZE, testEnv } from "./helpers";

const alice = { userId: 1, login: "alice" };
const bob = { userId: 2, login: "bob" };
const carol = { userId: 3, login: "carol" };

/** An OAuth stub holding grants by user ID, listed two to a page. */
function stubOAuth(grants: Record<string, string[]>) {
  const revoked: [string, string][] = [];
  const oauth: GrantRevoker = {
    async listUserGrants(userId, options) {
      const all = grants[userId] ?? [];
      const start = Number(options?.cursor ?? 0);
      const items = all.slice(start, start + 2).map((id) => ({ id }) as never);
      return { items, cursor: start + 2 < all.length ? String(start + 2) : undefined };
    },
    async revokeGrant(grantId, userId) {
      revoked.push([grantId, userId]);
    },
  };
  return { oauth, revoked };
}

/** testEnv's bucket, recording deletes and multipart aborts. */
function recordingEnv() {
  const inner = ssecBucket();
  const deleted: string[] = [];
  const aborted: string[] = [];
  const bucket = new Proxy(inner, {
    get(target, prop) {
      if (prop === "delete")
        return async (keys: string | string[]) => {
          deleted.push(...[keys].flat());
          return target.delete(keys);
        };
      if (prop === "resumeMultipartUpload")
        return (key: string, uploadId: string) => {
          const upload = target.resumeMultipartUpload(key, uploadId);
          return {
            ...upload,
            abort: async () => {
              aborted.push(key);
              return upload.abort();
            },
          };
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: testEnv({ bucket }), deleted, aborted };
}

const ctx = () => schoolsContext(env);

async function upload(workerEnv: Env, owner: typeof alice, size: number, shareWith: string[] = []) {
  const up = await createUpload(filesContext(workerEnv, TEST_PART_SIZE), owner, {
    name: "notes.txt",
    size,
    share_with: shareWith,
  });
  await env.BUCKET.put(objectKey(up.file.id), "bytes");
  return up.file.id;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await resetDb();
  await addUser(alice.userId, alice.login);
  await addUser(bob.userId, bob.login);
  await addUser(carol.userId, carol.login);
});

describe("deleteAccount", () => {
  it("deletes the account's files from R2 and D1, and its place on others' share lists", async () => {
    const rec = recordingEnv();
    const small = await upload(rec.env, alice, 5, ["bob"]);
    const big = await upload(rec.env, alice, TEST_PART_SIZE + 1);
    const bobs = await upload(rec.env, bob, 7, ["alice", "carol"]);
    const bigRow = await env.DB.prepare("SELECT r2_upload_id FROM files WHERE id = ?")
      .bind(big)
      .first<{ r2_upload_id: string | null }>();
    expect(bigRow?.r2_upload_id).not.toBeNull();

    const result = await deleteAccount(rec.env, stubOAuth({}).oauth, alice.userId);
    expect(result?.files).toBe(2);
    expect(rec.deleted.sort()).toEqual([objectKey(small), objectKey(big)].sort());
    expect(rec.aborted).toEqual([objectKey(big)]);
    expect(await env.BUCKET.head(objectKey(small))).toBeNull();
    expect(await env.BUCKET.head(objectKey(bobs))).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM files WHERE owner_id = 1")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM file_shares WHERE user_id = 1")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM file_shares WHERE file_id = ?", small)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM upload_parts WHERE file_id = ?", big)).toBe(0);
    // Bob's file is untouched, still shared with carol.
    expect(await count("SELECT COUNT(*) AS n FROM file_shares WHERE file_id = ?", bobs)).toBe(1);
    // The cached service total is refreshed in the same transaction.
    expect(await serviceResidentBytes(env.DB)).toBe(7);
  });

  it("deletes schools it was the only accepted member of, and leaves the others", async () => {
    const solo = await createSchool(ctx(), alice.userId, "mine", "group");
    const pendingOnly = await createSchool(ctx(), alice.userId, "waiting", "pair", ["bob"]);
    const shared = await createSchool(ctx(), alice.userId, "team", "group", ["bob", "carol"]);
    await acceptInvite(ctx(), bob.userId, shared.school.id);
    const invitedTo = await createSchool(ctx(), bob.userId, "bob's", "pair", ["alice"]);

    const result = await deleteAccount(env, stubOAuth({}).oauth, alice.userId);
    expect(result?.schoolsDeleted).toBe(2);
    const left = await env.DB.prepare("SELECT id, created_by FROM schools ORDER BY name").all<{
      id: string;
      created_by: number;
    }>();
    // The school alice created passes to the accepted member, bob, not to pending carol.
    expect(left.results).toEqual([
      { id: invitedTo.school.id, created_by: bob.userId },
      { id: shared.school.id, created_by: bob.userId },
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM school_members WHERE user_id = 1")).toBe(0);
    for (const gone of [solo, pendingOnly]) {
      expect(await count("SELECT COUNT(*) AS n FROM schools WHERE id = ?", gone.school.id)).toBe(0);
    }
    expect(
      await count("SELECT COUNT(*) AS n FROM school_members WHERE school_id = ?", shared.school.id),
    ).toBe(2);
  });

  it("deletes its messages everywhere, raising seq_floor so their seqs are never reused", async () => {
    const id = (await createSchool(ctx(), bob.userId, "team", "group", ["alice", "carol"])).school
      .id;
    await acceptInvite(ctx(), alice.userId, id);
    await acceptInvite(ctx(), carol.userId, id);
    const left = (await createSchool(ctx(), alice.userId, "old", "group", ["bob"])).school.id;
    await acceptInvite(ctx(), bob.userId, left);
    const ha = (await joinSession(ctx(), alice.userId, "chat", "a", "test")).handle;
    const hb = (await joinSession(ctx(), bob.userId, "chat", "b", "test")).handle;
    const hc = (await joinSession(ctx(), carol.userId, "chat", "c", "test")).handle;
    await sendMessage(ctx(), alice.userId, ha, id, "from alice 1");
    await sendMessage(ctx(), bob.userId, hb, id, "reply to alice", [], 1);
    await sendMessage(ctx(), alice.userId, ha, id, "from alice 3");
    // A message in a school alice has since left goes too.
    await sendMessage(ctx(), alice.userId, ha, left, "said before leaving");
    await leaveSchool(ctx(), alice.userId, left);
    await readMessages(ctx(), alice.userId, ha, id);

    const result = await deleteAccount(env, stubOAuth({}).oauth, alice.userId);
    expect(result?.messages).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE sender_id = 1")).toBe(0);
    expect(await count("SELECT seq_floor AS n FROM schools WHERE id = ?", id)).toBe(3);
    expect(await count("SELECT seq_floor AS n FROM schools WHERE id = ?", left)).toBe(1);

    const page = await transcript(ctx(), bob.userId, id);
    expect(page.messages.map((m) => [m.seq, m.text])).toEqual([[2, "reply to alice"]]);
    expect(page.messages[0]?.replyTo).toEqual({ seq: 1, parent: null });
    const next = await sendMessage(ctx(), bob.userId, hb, id, "after");
    expect(next.seq).toBe(4);
    // Carol reads past the gaps; what she reads is what's left.
    const read = await readMessages(ctx(), carol.userId, hc, id);
    expect(read.messages.map((m) => m.seq)).toEqual([2, 4]);
    expect((await checkUnread(ctx(), carol.userId, hc)).schools[0]?.unread).toBe(0);
  });

  it("deletes its sessions and read positions, its invite, and the users row last", async () => {
    const id = (await createSchool(ctx(), bob.userId, "team", "group", ["alice"])).school.id;
    await acceptInvite(ctx(), alice.userId, id);
    const ha = (await joinSession(ctx(), alice.userId, "chat", "a", "test")).handle;
    const hb = (await joinSession(ctx(), bob.userId, "chat", "b", "test")).handle;
    await sendMessage(ctx(), bob.userId, hb, id, "hi");
    await readMessages(ctx(), alice.userId, ha, id);
    await readMessages(ctx(), bob.userId, hb, id);
    await addInvite(env.DB, "ALICE", Date.now());
    await addInvite(env.DB, "carol", Date.now());
    await env.DB.prepare(
      "INSERT INTO school_invites_sent (day, user_id, sent) VALUES (1, 1, 3)",
    ).run();

    await deleteAccount(env, stubOAuth({}).oauth, alice.userId);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 1")).toBe(0);
    expect(
      await count("SELECT COUNT(*) AS n FROM read_positions WHERE session_handle = ?", ha),
    ).toBe(0);
    expect(
      await count("SELECT COUNT(*) AS n FROM read_positions WHERE session_handle = ?", hb),
    ).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM invites")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = 1")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM users")).toBe(2);
    // The day's invite count outlives the account, so deleting doesn't reset it.
    expect(await count("SELECT sent AS n FROM school_invites_sent WHERE user_id = 1")).toBe(3);
  });

  it("revokes every OAuth grant for the account, across pages, before deleting", async () => {
    const { oauth, revoked } = stubOAuth({ "1": ["g1", "g2", "g3"], "2": ["g4"] });
    const result = await deleteAccount(env, oauth, alice.userId);
    expect(result?.grants).toBe(3);
    expect(revoked).toEqual([
      ["g1", "1"],
      ["g2", "1"],
      ["g3", "1"],
    ]);
  });

  it("keeps everything if revoking grants fails, and returns null for no account", async () => {
    const failing: GrantRevoker = {
      ...stubOAuth({ "1": ["g1"] }).oauth,
      async revokeGrant() {
        throw new Error("KV down");
      },
    };
    await expect(deleteAccount(env, failing, alice.userId)).rejects.toThrow("KV down");
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = 1")).toBe(1);
    expect(await deleteAccount(env, stubOAuth({}).oauth, 999)).toBeNull();
  });
});
