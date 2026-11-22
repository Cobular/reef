import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateKey } from "../src/files/key";
import { createUpload, filesContext } from "../src/files/service";
import { issueToken } from "../src/files/tokens";
import { bytesToHex } from "../src/lib/base64";
import {
  addUser,
  call,
  fileRow,
  ORIGIN,
  resetDb,
  TEST_PART_SIZE,
  testEnv,
  testWorker,
} from "./helpers";

const alice = { userId: 1, login: "alice" };
const bob = { userId: 2, login: "bob" };
const carol = { userId: 3, login: "carol" };
const worker = testWorker();

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

async function digest(data: ArrayBuffer | Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

async function newUpload(
  size: number,
  options: { download_limit?: number; share_with?: string[]; lifetime_minutes?: number } = {},
) {
  return createUpload(filesContext(testEnv(), TEST_PART_SIZE), alice, {
    name: "data.bin",
    size,
    ...options,
  });
}

function put(path: string, key: string | null, body: Uint8Array | null, headers = {}) {
  const h = new Headers(headers);
  if (key) h.set("X-Key", key);
  // A Request built in-process has no Content-Length; one arriving over HTTP does.
  if (body && !h.has("Content-Length")) h.set("Content-Length", String(body.byteLength));
  return call(worker, new Request(`${ORIGIN}${path}`, { method: "PUT", headers: h, body }));
}

async function downloadToken(fileId: string, userId: number): Promise<string> {
  return issueToken(env.TOKEN_SIGNING_KEY, "dl", fileId, userId, Date.now());
}

function get(token: string, key: string | null, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  if (key) h.set("X-Key", key);
  return call(worker, new Request(`${ORIGIN}/dl/${token}`, { headers: h }));
}

async function uploaded(size: number, options: Parameters<typeof newUpload>[1] = {}) {
  const up = await newUpload(size, options);
  const body = bytes(size);
  const res = await put(`/up/${up.token}`, up.key, body);
  expect(res.status).toBe(200);
  return { ...up, body };
}

beforeEach(async () => {
  await resetDb();
  await addUser(alice.userId, alice.login);
  await addUser(bob.userId, bob.login);
  await addUser(carol.userId, carol.login);
});

describe("single upload", () => {
  it("stores the file and prints the exact expiry", async () => {
    const up = await newUpload(1000, { lifetime_minutes: 5 });
    const before = Date.now();
    const res = await put(`/up/${up.token}`, up.key, bytes(1000));
    expect(res.status).toBe(200);
    const row = await fileRow(up.file.id);
    expect(row?.state).toBe("ready");
    expect(row?.expires_at).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(await res.text()).toContain(new Date(row?.expires_at ?? 0).toISOString().slice(0, 19));
  });

  it("refuses a second upload to the same token", async () => {
    const up = await uploaded(10);
    const again = await put(`/up/${up.token}`, up.key, bytes(10));
    expect(again.status).toBe(409);
  });

  it("requires a valid key", async () => {
    const up = await newUpload(10);
    expect((await put(`/up/${up.token}`, null, bytes(10))).status).toBe(400);
    expect((await put(`/up/${up.token}`, "bm90LWEta2V5", bytes(10))).status).toBe(400);
  });

  it("rejects bad, tampered and wrong-action tokens", async () => {
    const up = await newUpload(10);
    expect((await put(`/up/x.y`, up.key, bytes(10))).status).toBe(401);
    const tampered = `${up.token.slice(0, -2)}AA`;
    expect((await put(`/up/${tampered}`, up.key, bytes(10))).status).toBe(401);
    const dl = await downloadToken(up.file.id, alice.userId);
    expect((await put(`/up/${dl}`, up.key, bytes(10))).status).toBe(401);
  });

  it("enforces the declared size", async () => {
    const up = await newUpload(100);
    expect((await put(`/up/${up.token}`, up.key, bytes(101))).status).toBe(413);
    expect((await put(`/up/${up.token}`, up.key, bytes(99))).status).toBe(400);
    expect((await fileRow(up.file.id))?.state).toBe("pending");
  });

  it("requires Content-Length", async () => {
    const up = await newUpload(100);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes(100));
        c.close();
      },
    });
    const res = await call(
      worker,
      new Request(`${ORIGIN}/up/${up.token}`, {
        method: "PUT",
        headers: { "X-Key": up.key },
        body: stream,
        // @ts-expect-error duplex is required by some runtimes for streaming bodies.
        duplex: "half",
      }),
    );
    expect(res.status).toBe(411);
  });

  it("refuses a stream that sends more bytes than its Content-Length says", async () => {
    const up = await newUpload(100);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    writer
      .write(bytes(150))
      .then(() => writer.close())
      .catch(() => {});
    const res = await call(
      worker,
      new Request(`${ORIGIN}/up/${up.token}`, {
        method: "PUT",
        headers: { "X-Key": up.key, "Content-Length": "100" },
        body: readable,
        // @ts-expect-error duplex is required by some runtimes for streaming bodies.
        duplex: "half",
      }),
    );
    expect(res.status).toBe(413);
    expect((await fileRow(up.file.id))?.state).toBe("pending");
  });

  it("uploads an empty file", async () => {
    const up = await newUpload(0);
    expect((await put(`/up/${up.token}`, up.key, new Uint8Array(0))).status).toBe(200);
    const res = await get(await downloadToken(up.file.id, alice.userId), up.key);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("refuses wrong methods", async () => {
    const up = await newUpload(10);
    const res = await call(worker, new Request(`${ORIGIN}/up/${up.token}`, { method: "GET" }));
    expect(res.status).toBe(405);
  });
});

describe("multipart upload", () => {
  const size = TEST_PART_SIZE * 2 + 1234;

  it("uploads parts in any order, completes, and downloads intact", async () => {
    const up = await newUpload(size);
    expect(up.parts).toBe(3);
    const body = bytes(size, 3);
    const slice = (n: number) => body.slice((n - 1) * TEST_PART_SIZE, n * TEST_PART_SIZE);

    const early = await call(
      worker,
      new Request(`${ORIGIN}/up/${up.token}/complete`, {
        method: "POST",
        headers: { "X-Key": up.key },
      }),
    );
    expect(early.status).toBe(400);
    expect(await early.text()).toContain("Missing parts: 1, 2, 3");

    for (const n of [3, 1, 2]) {
      const res = await put(`/up/${up.token}/${n}`, up.key, slice(n));
      expect(res.status, await res.clone().text()).toBe(200);
    }
    // Retrying a part replaces it.
    expect((await put(`/up/${up.token}/2`, up.key, slice(2))).status).toBe(200);
    expect((await put(`/up/${up.token}/4`, up.key, bytes(10))).status).toBe(400);
    expect((await put(`/up/${up.token}`, up.key, body)).status).toBe(400);

    const done = await call(
      worker,
      new Request(`${ORIGIN}/up/${up.token}/complete`, {
        method: "POST",
        headers: { "X-Key": up.key },
      }),
    );
    expect(done.status, await done.clone().text()).toBe(200);
    expect((await fileRow(up.file.id))?.state).toBe("ready");

    const res = await get(await downloadToken(up.file.id, alice.userId), up.key);
    expect(res.status).toBe(200);
    expect(await digest(await res.arrayBuffer())).toBe(await digest(body));
  });

  it("checks each part's size", async () => {
    const up = await newUpload(size);
    expect((await put(`/up/${up.token}/1`, up.key, bytes(TEST_PART_SIZE - 1))).status).toBe(400);
    expect((await put(`/up/${up.token}/3`, up.key, bytes(1235))).status).toBe(413);
  });

  it("refuses a part sent with a different key", async () => {
    const up = await newUpload(size);
    const res = await put(`/up/${up.token}/1`, generateKey(), bytes(TEST_PART_SIZE));
    expect(res.status).toBe(403);
  });
});

describe("download", () => {
  it("serves the owner and the share list, with safe headers", async () => {
    const up = await uploaded(64, { share_with: ["bob"] });
    const res = await get(await downloadToken(up.file.id, bob.userId), up.key);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(up.body);
  });

  it("refuses a wrong key with 403", async () => {
    const up = await uploaded(64);
    const res = await get(await downloadToken(up.file.id, alice.userId), generateKey());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/wrong key/i);
  });

  it("refuses accounts removed from the share list after the token was issued", async () => {
    const up = await uploaded(64, { share_with: ["bob"] });
    const token = await downloadToken(up.file.id, bob.userId);
    await env.DB.prepare("DELETE FROM file_shares WHERE file_id = ?").bind(up.file.id).run();
    expect((await get(token, up.key)).status).toBe(401);
    const stranger = await downloadToken(up.file.id, carol.userId);
    expect((await get(stranger, up.key)).status).toBe(401);
  });

  it("expires download tokens after 60 seconds", async () => {
    const up = await uploaded(8);
    const old = await issueToken(
      env.TOKEN_SIGNING_KEY,
      "dl",
      up.file.id,
      alice.userId,
      Date.now() - 61_000,
    );
    expect((await get(old, up.key)).status).toBe(401);
  });

  it("returns 410 once the file has expired", async () => {
    const up = await uploaded(8);
    await env.DB.prepare("UPDATE files SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, up.file.id)
      .run();
    expect((await get(await downloadToken(up.file.id, alice.userId), up.key)).status).toBe(410);
  });

  it("returns 409 before the upload finishes", async () => {
    const up = await newUpload(8);
    expect((await get(await downloadToken(up.file.id, alice.userId), up.key)).status).toBe(409);
  });

  it("enforces the download limit, counting only requests that include byte 0", async () => {
    const up = await uploaded(100, { download_limit: 2 });
    const token = await downloadToken(up.file.id, alice.userId);

    const first = await get(token, up.key, { Range: "bytes=0-9" });
    expect(first.status).toBe(206);
    expect(first.headers.get("Content-Range")).toBe("bytes 0-9/100");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(up.body.slice(0, 10));

    const resume = await get(token, up.key, { Range: "bytes=10-" });
    expect(resume.status).toBe(206);
    expect(new Uint8Array(await resume.arrayBuffer())).toEqual(up.body.slice(10));
    expect((await fileRow(up.file.id))?.download_count).toBe(1);

    expect((await get(token, up.key)).status).toBe(200);
    expect((await fileRow(up.file.id))?.download_count).toBe(2);
    expect((await get(token, up.key)).status).toBe(410);
    // A resume of a download already started is still allowed.
    expect((await get(token, up.key, { Range: "bytes=50-" })).status).toBe(206);
  });

  it("answers an unsatisfiable range with 416", async () => {
    const up = await uploaded(100);
    const res = await get(await downloadToken(up.file.id, alice.userId), up.key, {
      Range: "bytes=500-",
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */100");
  });

  it("accepts the key as a form field on POST", async () => {
    const up = await uploaded(16);
    const token = await downloadToken(up.file.id, alice.userId);
    const res = await call(
      worker,
      new Request(`${ORIGIN}/dl/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ key: up.key }),
      }),
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(up.body);
  });

  it("refuses suspended accounts and files of suspended owners", async () => {
    const up = await uploaded(16, { share_with: ["bob"] });
    const bobToken = await downloadToken(up.file.id, bob.userId);
    await env.DB.prepare("UPDATE users SET banned = 1 WHERE id = ?").bind(alice.userId).run();
    expect((await get(bobToken, up.key)).status).toBe(410);
    await env.DB.prepare("UPDATE users SET banned = 1 WHERE id = ?").bind(bob.userId).run();
    expect((await get(bobToken, up.key)).status).toBe(403);
  });
});

describe("quotas", () => {
  it("caps uploads per day", async () => {
    const now = Date.now();
    const insert = env.DB.prepare(
      "INSERT INTO files (id, owner_id, name, size, state, lifetime_minutes, created_at) VALUES (?, ?, 'x', 1, 'deleted', 10, ?)",
    );
    await env.DB.batch(
      Array.from({ length: 50 }, (_, i) => insert.bind(`old${i}`, alice.userId, now - i)),
    );
    await expect(newUpload(1)).rejects.toMatchObject({ status: 429 });
  });

  it("caps resident bytes per account", async () => {
    await env.DB.prepare(
      "INSERT INTO files (id, owner_id, name, size, state, lifetime_minutes, created_at, expires_at) VALUES ('big', ?, 'x', ?, 'ready', 10, ?, ?)",
    )
      .bind(alice.userId, 9 * 1024 ** 3, Date.now() - 1000 * 3600 * 25, Date.now() + 60_000)
      .run();
    await expect(newUpload(2 * 1024 ** 3)).rejects.toMatchObject({ status: 413 });
    await expect(newUpload(1024)).resolves.toBeTruthy();
  });
});
