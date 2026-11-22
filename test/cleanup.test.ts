import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, STALE_UPLOAD_MS } from "../src/files/cleanup";
import { createUpload, filesContext } from "../src/files/service";
import { objectKey } from "../src/files/storage";
import { addUser, fileRow, resetDb, TEST_PART_SIZE, testEnv, testWorker } from "./helpers";

const alice = { userId: 1, login: "alice" };
const bob = { userId: 2, login: "bob" };

beforeEach(async () => {
  await resetDb();
  await addUser(alice.userId, alice.login);
  await addUser(bob.userId, bob.login);
});

async function readyFile(expiresAt: number) {
  const up = await createUpload(filesContext(testEnv(), TEST_PART_SIZE), alice, {
    name: "f.txt",
    size: 3,
    share_with: ["bob"],
  });
  await env.BUCKET.put(objectKey(up.file.id), "abc");
  await env.DB.prepare("UPDATE files SET state = 'ready', expires_at = ? WHERE id = ?")
    .bind(expiresAt, up.file.id)
    .run();
  return up.file.id;
}

describe("cron cleanup", () => {
  it("deletes expired objects and marks their rows deleted", async () => {
    const now = Date.now();
    const expired = await readyFile(now - 1000);
    const live = await readyFile(now + 60_000);
    const result = await cleanup(testEnv(), now);
    expect(result.expired).toBe(1);
    expect((await fileRow(expired))?.state).toBe("deleted");
    expect(await env.BUCKET.head(objectKey(expired))).toBeNull();
    expect((await fileRow(live))?.state).toBe("ready");
    expect(await env.BUCKET.head(objectKey(live))).not.toBeNull();
  });

  it("aborts uploads that can no longer finish", async () => {
    const ctx = filesContext(testEnv(), TEST_PART_SIZE);
    const big = await createUpload(ctx, alice, { name: "big", size: TEST_PART_SIZE + 1 });
    expect(big.file.r2_upload_id).not.toBeNull();
    const fresh = await createUpload(ctx, alice, { name: "new", size: 1 });
    const result = await cleanup(testEnv(), Date.now() + STALE_UPLOAD_MS + 1000);
    expect(result.abandoned).toBe(2);
    expect((await fileRow(big.file.id))?.state).toBe("deleted");
    expect((await fileRow(fresh.file.id))?.state).toBe("deleted");
    const recent = await createUpload(ctx, alice, { name: "recent", size: 1 });
    await cleanup(testEnv(), Date.now());
    expect((await fileRow(recent.file.id))?.state).toBe("pending");
  });

  it("purges rows and their share lists 24 hours after expiry", async () => {
    const now = Date.now();
    const id = await readyFile(now - 1000);
    await cleanup(testEnv(), now);
    expect(await fileRow(id)).not.toBeNull();
    const later = await cleanup(testEnv(), now + 24 * 3600_000 + 1000);
    // D1 counts the cascaded share-list rows in `changes` too.
    expect(later.purged).toBeGreaterThanOrEqual(1);
    expect(await fileRow(id)).toBeNull();
    const shares = await env.DB.prepare("SELECT COUNT(*) AS n FROM file_shares WHERE file_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(shares?.n).toBe(0);
  });

  it("runs from the scheduled handler", async () => {
    const id = await readyFile(Date.now() - 1000);
    const controller = createScheduledController({
      scheduledTime: Date.now(),
      cron: "*/5 * * * *",
    });
    await testWorker().scheduled(controller, testEnv(), createExecutionContext());
    expect((await fileRow(id))?.state).toBe("deleted");
  });
});
