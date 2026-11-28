import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { RATE_LIMITS, SESSION_COOKIE } from "../src/config";
import { cleanup } from "../src/files/cleanup";
import { createUpload, filesContext, shareFile } from "../src/files/service";
import { issueToken } from "../src/files/tokens";
import { mcpApiHandler } from "../src/mcp/server";
import wranglerConfig from "../wrangler.jsonc?raw";
import {
  addUser,
  call,
  fileRow,
  ORIGIN,
  portalSessionFor,
  type RateLimitBinding,
  readRpc,
  resetDb,
  rpcRequest,
  stubLimiter,
  TEST_PART_SIZE,
  testEnv,
  testWorker,
} from "./helpers";

const alice = { userId: 1, login: "alice" };
const bob = { userId: 2, login: "bob" };
const IP = "203.0.113.9";
const worker = testWorker();

beforeEach(async () => {
  await resetDb();
  await addUser(alice.userId, alice.login);
  await addUser(bob.userId, bob.login);
});

/** An env whose named limiter refuses everything, plus that limiter's recorded keys. */
function denying(binding: RateLimitBinding) {
  const stub = stubLimiter();
  return { env: testEnv({ limiters: { [binding]: stub.limiter } }), keys: stub.keys };
}

function fromIp(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", IP);
  return new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers });
}

function upload(size: number, workerEnv = testEnv()) {
  return createUpload(filesContext(workerEnv, TEST_PART_SIZE), alice, { name: "a.bin", size });
}

async function sessionCookie(userId: number): Promise<string> {
  return (await portalSessionFor(userId)).cookie;
}

async function portalPost(path: string, workerEnv: Env, accept?: string): Promise<Response> {
  const session = await portalSessionFor(alice.userId);
  const body = new URLSearchParams({ csrf: session.csrf });
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: session.cookie,
    Origin: ORIGIN,
  });
  if (accept) headers.set("Accept", accept);
  return call(
    worker,
    new Request(`${ORIGIN}${path}`, { method: "POST", headers, body, redirect: "manual" }),
    workerEnv,
  );
}

/** Calls /mcp as an authorised account and returns the raw response. */
async function mcpAs(user: typeof alice, request: Request, workerEnv: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const authed = Object.assign(Object.create(ctx), { props: user }) as ExecutionContext;
  const response = await mcpApiHandler(TEST_PART_SIZE).fetch(request, workerEnv, authed);
  await waitOnExecutionContext(ctx);
  return response;
}

function expectRetryAfter(response: Response) {
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
}

describe("rate limit config", () => {
  it("matches wrangler.jsonc, and the local runtime provides every binding", () => {
    const found = [
      ...wranglerConfig.matchAll(
        /"name":\s*"(RL_\w+)",\s*"namespace_id":\s*"(\d+)",\s*"simple":\s*\{\s*"limit":\s*(\d+),\s*"period":\s*(\d+)/g,
      ),
    ].map(([, name, ns, limit, period]) => ({
      name,
      ns,
      limit: Number(limit),
      period: Number(period),
    }));
    const expected = Object.values(RATE_LIMITS).map((l) => ({
      name: l.binding,
      limit: l.limit,
      period: l.period,
    }));
    expect(found.map(({ name, limit, period }) => ({ name, limit, period }))).toEqual(expected);
    expect(new Set(found.map((f) => f.ns)).size).toBe(found.length);
    for (const { binding } of Object.values(RATE_LIMITS))
      expect(typeof env[binding]?.limit, binding).toBe("function");
  });
});

describe("per-IP flood guard", () => {
  it("refuses a portal page with the error page, keyed by CF-Connecting-IP", async () => {
    const { env: e, keys } = denying("RL_IP");
    const res = await call(worker, fromIp("/"), e);
    expectRetryAfter(res);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("Too many requests from your network. Wait 60 seconds");
    expect(keys).toEqual([IP]);
  });

  it("is skipped without CF-Connecting-IP", async () => {
    const { env: e, keys } = denying("RL_IP");
    expect((await call(worker, new Request(`${ORIGIN}/`), e)).status).toBe(200);
    expect(keys).toEqual([]);
  });

  it("answers an MCP tool call with a tool error, and other MCP requests with 429", async () => {
    const { env: e } = denying("RL_IP");
    const asIp = (r: Request) =>
      fromIp("/mcp", { method: "POST", headers: r.headers, body: r.body });
    const tool = await call(worker, asIp(rpcRequest("tools/call", { name: "list_files" })), e);
    expect(tool.status).toBe(200);
    expect(tool.headers.get("Retry-After")).toBe("60");
    const rpc = await readRpc(tool);
    expect(rpc.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Too many requests") }],
    });
    const list = await call(worker, asIp(rpcRequest("tools/list")), e);
    expectRetryAfter(list);
    expect((await readRpc(list)).error?.message).toContain("Too many requests");
  });

  it("refuses the data API in plain text", async () => {
    const { env: e } = denying("RL_IP");
    const res = await call(worker, fromIp("/dl/x.y"), e);
    expectRetryAfter(res);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });
});

describe("flood limits after sign-in", () => {
  it("keys a signed-in portal request by account, not IP", async () => {
    const ipOnly = denying("RL_IP");
    const page = fromIp("/files", { headers: { Cookie: await sessionCookie(alice.userId) } });
    expect((await call(worker, page, ipOnly.env)).status).toBe(200);
    expect(ipOnly.keys).toEqual([]);

    const { env: e, keys } = denying("RL_ACCOUNT");
    const again = fromIp("/files", { headers: { Cookie: await sessionCookie(alice.userId) } });
    const res = await call(worker, again, e);
    expectRetryAfter(res);
    expect(await res.text()).toContain("Too many requests from this account.");
    expect(keys).toEqual([String(alice.userId)]);
    // A forged cookie falls back to the per-IP limit.
    const forged = fromIp("/files", { headers: { Cookie: `${SESSION_COOKIE}=x.y` } });
    expectRetryAfter(await call(worker, forged, ipOnly.env));
  });

  it("puts bearer-token MCP requests in the larger per-IP bucket", async () => {
    const ipOnly = denying("RL_IP");
    const withBearer = () =>
      fromIp("/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    // Past the flood guard, the OAuth provider refuses the made-up token.
    expect((await call(worker, withBearer(), ipOnly.env)).status).toBe(401);
    expect(ipOnly.keys).toEqual([]);
    const { env: e, keys } = denying("RL_BEARER");
    expectRetryAfter(await call(worker, withBearer(), e));
    expect(keys).toEqual([IP]);
  });

  it("skips the per-IP limit for a validly signed data token", async () => {
    const up = await upload(10);
    const { env: e, keys } = denying("RL_IP");
    const dl = await issueToken(env.TOKEN_SIGNING_KEY, "dl", up.file.id, alice.userId, Date.now());
    // Not 429: the per-IP limit is skipped (the file isn't uploaded yet, hence not 200).
    expect((await call(worker, fromIp(`/dl/${dl}`), e)).status).not.toBe(429);
    expect(keys).toEqual([]);
    expectRetryAfter(await call(worker, fromIp("/dl/x.y"), e));
  });
});

describe("per-IP sign-in limit", () => {
  it("covers the sign-in pages and OAuth endpoints only", async () => {
    const { env: e, keys } = denying("RL_AUTH");
    const login = await call(worker, fromIp("/login"), e);
    expectRetryAfter(login);
    expect(await login.text()).toContain("Too many sign-in attempts");
    const token = await call(
      worker,
      fromIp("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=x",
      }),
      e,
    );
    expectRetryAfter(token);
    expect(await token.json()).toMatchObject({ error: "rate_limited" });
    for (const path of ["/authorize", "/oauth/register", "/auth/callback/mcp"])
      expect((await call(worker, fromIp(path, { method: "POST" }), e)).status, path).toBe(429);
    expect((await call(worker, fromIp("/"), e)).status).toBe(200);
    expect(keys.every((k) => k === IP)).toBe(true);
  });
});

describe("per-account MCP limit", () => {
  it("turns a tool call into a tool error before touching D1, keyed by account", async () => {
    const { env: e, keys } = denying("RL_MCP");
    // A deleted account would get 403 from the D1 lookup; the limit answers first.
    await resetDb();
    const res = await mcpAs(alice, rpcRequest("tools/call", { name: "list_files" }), e);
    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect((await readRpc(res)).result).toMatchObject({
      isError: true,
      content: [
        { text: "Too many Reef requests from this account. Wait 60 seconds, then try again." },
      ],
    });
    expect(keys).toEqual(["1"]);
    const list = await mcpAs(alice, rpcRequest("tools/list"), e);
    expectRetryAfter(list);
    expect((await readRpc(list)).error?.code).toBe(-32000);
  });

  it("limits create_upload by the per-account write limit", async () => {
    const { env: e, keys } = denying("RL_WRITE");
    const res = await mcpAs(
      alice,
      rpcRequest("tools/call", { name: "create_upload", arguments: { name: "a.txt", size: 1 } }),
      e,
    );
    expect((await readRpc(res)).result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("Too many changes from this account") }],
    });
    expect(keys).toEqual(["1"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM files").first("n")).toBe(0);
  });
});

describe("per-account data limit", () => {
  it("refuses uploads and downloads with 429 after the token check", async () => {
    const up = await upload(10);
    const { env: e, keys } = denying("RL_DATA");
    const put = await call(
      worker,
      new Request(`${ORIGIN}/up/${up.token}`, {
        method: "PUT",
        headers: { "X-Key": up.key, "Content-Length": "10" },
        body: new Uint8Array(10),
      }),
      e,
    );
    expectRetryAfter(put);
    expect(await put.text()).toContain("Too many uploads and downloads from this account.");
    expect((await fileRow(up.file.id))?.state).toBe("pending");
    const dl = await issueToken(env.TOKEN_SIGNING_KEY, "dl", up.file.id, alice.userId, Date.now());
    expectRetryAfter(await call(worker, new Request(`${ORIGIN}/dl/${dl}`), e));
    expect(keys).toEqual(["1", "1"]);
    // A forged token is refused before the limiter is consulted.
    expect((await call(worker, new Request(`${ORIGIN}/dl/x.y`), e)).status).toBe(401);
    expect(keys).toHaveLength(2);
  });
});

describe("per-account portal write limit", () => {
  it("refuses form posts with the error page, and the upload form with JSON", async () => {
    const up = await upload(10);
    const { env: e, keys } = denying("RL_WRITE");
    const del = await portalPost(`/files/${up.file.id}/delete`, e);
    expectRetryAfter(del);
    expect(del.headers.get("Content-Type")).toContain("text/html");
    expect(await del.text()).toContain("Too many changes from this account.");
    expect((await fileRow(up.file.id))?.state).toBe("pending");
    const create = await portalPost("/files/new", e, "application/json");
    expectRetryAfter(create);
    expect(await create.json()).toEqual({
      error: {
        field: "form",
        message: "Too many changes from this account. Wait 60 seconds, then try again.",
      },
    });
    expect(keys).toEqual(["1", "1"]);
    const page = await call(
      worker,
      new Request(`${ORIGIN}/files`, { headers: { Cookie: await sessionCookie(alice.userId) } }),
      e,
    );
    expect(page.status).toBe(200);
  });
});

describe("request body size", () => {
  const big = new Uint8Array(65 * 1024).fill(97);

  it("refuses a declared form body over 64 KiB with 413", async () => {
    const res = await call(
      worker,
      new Request(`${ORIGIN}/files/new`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": `${big.byteLength}`,
        },
        body: big,
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("the limit here is 64 KiB");
  });

  it("refuses a chunked body over the limit without buffering it whole", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(16 * 1024));
        if (pulled > 100) c.close();
      },
    });
    const res = await call(
      worker,
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: stream,
      }),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it("allows MCP bodies up to 1 MiB and refuses larger ones as JSON-RPC", async () => {
    const res = await call(
      worker,
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": `${2 * 1024 * 1024}` },
        body: new Uint8Array(2 * 1024 * 1024),
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { message: expect.stringContaining("1024 KiB") },
    });
    // Over the form limit but under the MCP one: passes the guard (and fails auth instead).
    const ok = await call(
      worker,
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": `${big.byteLength}` },
        body: big,
      }),
    );
    expect(ok.status).toBe(401);
  });
});

describe("security headers", () => {
  it("marks JSON and data responses nosniff and no-store", async () => {
    for (const request of [
      new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }),
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
      new Request(`${ORIGIN}/oauth/token`, { method: "POST", body: "grant_type=x" }),
      new Request(`${ORIGIN}/dl/x.y`),
    ]) {
      const res = await call(worker, request);
      expect(res.headers.get("X-Content-Type-Options"), request.url).toBe("nosniff");
      expect(res.headers.get("Cache-Control"), request.url).toBeTruthy();
    }
    const token = await call(
      worker,
      new Request(`${ORIGIN}/oauth/token`, { method: "POST", body: "grant_type=x" }),
    );
    expect(token.headers.get("Cache-Control")).toContain("no-store");
  });

  it("keeps HTML pages on Referrer-Policy: same-origin", async () => {
    const res = await call(worker, new Request(`${ORIGIN}/`));
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });
});

describe("quotas and bans", () => {
  it("caps resident bytes across the service", async () => {
    await env.DB.prepare(
      "INSERT INTO files (id, owner_id, name, size, state, lifetime_minutes, created_at, expires_at) VALUES ('big', ?, 'x', ?, 'ready', 10, ?, ?)",
    )
      .bind(bob.userId, 29.5 * 1024 ** 3, Date.now(), Date.now() + 60_000)
      .run();
    await expect(upload(1024 ** 3)).rejects.toMatchObject({
      status: 413,
      message: "Reef is full right now. Try again in a few minutes.",
    });
    await expect(upload(1024)).resolves.toBeTruthy();
  });

  it("caps resident bytes from the cron's cached total plus files created since", async () => {
    const GiB = 1024 ** 3;
    const now = Date.now();
    const insert = (id: string, size: number, state = "ready", expiresAt = now + 60_000) =>
      env.DB.prepare(
        "INSERT INTO files (id, owner_id, name, size, state, lifetime_minutes, created_at, expires_at) VALUES (?, ?, 'x', ?, ?, 10, ?, ?)",
      )
        .bind(id, bob.userId, size, state, now, expiresAt)
        .run();
    // The newest row is purged by the cron run that caches the total, so the next insert gets
    // its rowid back: it must still count as created since.
    await insert("big", 20 * GiB);
    await insert("purged", 1, "deleted", now - 2 * 24 * 60 * 60 * 1000);
    expect((await cleanup(testEnv(), now)).purged).toBe(1);
    await insert("late", 9.5 * GiB);
    await expect(upload(GiB)).rejects.toMatchObject({ status: 413 });
    await expect(upload(0.25 * GiB)).resolves.toBeTruthy();

    // A deleted file still counts until the next cron run refreshes the total: over, never under.
    await env.DB.prepare("UPDATE files SET state = 'deleted', expires_at = ? WHERE id = 'big'")
      .bind(now)
      .run();
    await expect(upload(GiB)).rejects.toMatchObject({ status: 413 });
    await cleanup(testEnv(), now);
    await expect(upload(GiB)).resolves.toBeTruthy();
  });

  it("caps share lists at 10 accounts, on create and on share", async () => {
    const logins = Array.from({ length: 11 }, (_, i) => `user${i}`);
    for (const [i, login] of logins.entries()) await addUser(100 + i, login);
    const ctx = filesContext(testEnv(), TEST_PART_SIZE);
    await expect(
      createUpload(ctx, alice, { name: "a", size: 1, share_with: logins }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("at most 10") });
    const up = await createUpload(ctx, alice, {
      name: "a",
      size: 1,
      share_with: logins.slice(0, 10),
    });
    await expect(shareFile(ctx, alice, up.file.id, ["bob"], [])).rejects.toMatchObject({
      status: 400,
    });
  });

  it("refuses a banned account's upload tokens and school sends", async () => {
    const up = await upload(10);
    await env.DB.prepare("UPDATE users SET banned = 1 WHERE id = ?").bind(alice.userId).run();
    const put = await call(
      worker,
      new Request(`${ORIGIN}/up/${up.token}`, {
        method: "PUT",
        headers: { "X-Key": up.key, "Content-Length": "10" },
        body: new Uint8Array(10),
      }),
    );
    expect(put.status).toBe(403);
    const send = await mcpAs(
      alice,
      rpcRequest("tools/call", {
        name: "school_send",
        arguments: { handle: "x", school: "y", text: "hi" },
      }),
      testEnv(),
    );
    expect(send.status).toBe(403);
  });
});
