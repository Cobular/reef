import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { pkceChallenge } from "../src/auth/github";
import { signValue } from "../src/auth/signed";
import { MAX_NEW_ACCOUNTS_PER_DAY, SESSION_COOKIE } from "../src/config";
import {
  addUser,
  call,
  ORIGIN,
  portalSessionFor,
  readRpc,
  resetDb,
  rpcRequest,
  stubGitHub,
  testEnv,
  testWorker,
} from "./helpers";

const gh = stubGitHub({
  alice: { id: 101, login: "alice" },
  bob: { id: 102, login: "bob" },
  mallory: { id: 666, login: "mallory" },
  renamed: { id: 101, login: "alice-new" },
});
const worker = testWorker(gh.api);

/** A tiny cookie jar: enough to carry Set-Cookie values to the next request. */
class Jar {
  private cookies = new Map<string, string>();
  take(response: Response): this {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim())) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }
  has(name: string): boolean {
    return this.cookies.has(name);
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function req(path: string, jar?: Jar, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (jar) headers.set("Cookie", jar.header());
  return new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, {
    redirect: "manual",
    ...init,
    headers,
  });
}

beforeEach(async () => {
  await resetDb();
  await env.DB.prepare(
    "INSERT INTO invites (login, created_at) VALUES ('Alice', 0), ('bob', 0)",
  ).run();
});

// ---- portal sign-in ------------------------------------------------------------------------

async function portalLogin(code: string, workerEnv = testEnv(), next?: string) {
  const jar = new Jar();
  const login = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  const start = await call(worker, req(login), workerEnv);
  expect(start.status).toBe(302);
  jar.take(start);
  const github = new URL(start.headers.get("Location") ?? "");
  expect(github.hostname).toBe("github.test");
  expect(github.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback/portal`);
  const state = github.searchParams.get("state") ?? "";
  const back = await call(
    worker,
    req(`/auth/callback/portal?code=${code}&state=${encodeURIComponent(state)}`, jar),
    workerEnv,
  );
  jar.take(back);
  return { jar, back, github };
}

/** The form token a signed-in page carries for this browser's session. */
async function formToken(jar: Jar): Promise<string> {
  const page = await (await call(worker, req("/account", jar))).text();
  return /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
}

describe("portal sign-in", () => {
  it("signs in an invited account (login matched case-insensitively) and sets a session", async () => {
    const { jar, back, github } = await portalLogin("alice");
    expect(back.status).toBe(302);
    expect(back.headers.get("Location")).toBe("/files");
    expect(jar.has("__Host-reef-session")).toBe(true);
    expect(back.headers.getSetCookie().join("\n")).toMatch(/HttpOnly; Secure; SameSite=Lax/);

    // PKCE: the verifier sent to GitHub matches the challenge in the authorize URL.
    const exchange = gh.calls.exchanges.at(-1);
    expect(await pkceChallenge(exchange?.codeVerifier ?? "")).toBe(
      github.searchParams.get("code_challenge"),
    );

    const portal = await call(worker, req("/files", jar));
    expect(portal.status).toBe(200);
    expect(await portal.text()).toContain("alice");
    const user = await env.DB.prepare("SELECT login FROM users WHERE id = 101").first();
    expect(user?.login).toBe("alice");
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const jar = new Jar();
    jar.take(await call(worker, req("/login")));
    const res = await call(worker, req("/auth/callback/portal?code=alice&state=forged", jar));
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie().join()).not.toContain("__Host-reef-session=");
    const noCookie = await call(worker, req("/auth/callback/portal?code=alice&state=forged"));
    expect(noCookie.status).toBe(400);
  });

  it("refuses accounts without an invite in invite mode, and admits them in open mode", async () => {
    const refused = await portalLogin("mallory");
    expect(refused.back.status).toBe(403);
    expect(await refused.back.text()).toMatch(/invite/i);
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = 666").first()).toBeNull();

    const open = await portalLogin("mallory", testEnv({ signupMode: "open" }));
    expect(open.back.status).toBe(302);
  });

  it("refuses banned accounts at sign-in and ends their sessions at once", async () => {
    const { jar } = await portalLogin("alice");
    await env.DB.prepare("UPDATE users SET banned = 1 WHERE id = 101").run();
    const portal = await call(worker, req("/files", jar));
    expect(portal.status).toBe(303);
    expect(portal.headers.get("Location")).toBe("/login?next=%2Ffiles");
    const again = await portalLogin("alice");
    expect(again.back.status).toBe(403);
    expect(await again.back.text()).toMatch(/suspended/i);
  });

  it("follows a GitHub rename by the numeric ID", async () => {
    await portalLogin("alice");
    const { back } = await portalLogin("renamed");
    expect(back.status).toBe(302);
    const user = await env.DB.prepare("SELECT login FROM users WHERE id = 101").first();
    expect(user?.login).toBe("alice-new");
  });

  it("refuses a session cookie without an issue time, or issued before the account existed", async () => {
    await addUser(7, "erin");
    const page = (cookie: string) =>
      call(worker, new Request(`${ORIGIN}/files`, { headers: { Cookie: cookie } }));
    expect((await page((await portalSessionFor(7)).cookie)).status).toBe(200);
    const noIat = await signValue(env.COOKIE_SECRET, "session", { uid: 7 }, Date.now() + 60_000);
    expect((await page(`${SESSION_COOKIE}=${noIat}`)).status).toBe(303);
    // A cookie from an account that was deleted and signed up again with the same GitHub ID.
    const old = await portalSessionFor(7, Date.now() - 60_000);
    expect((await page(old.cookie)).status).toBe(303);
  });

  it("returns to the page that asked for sign-in, and only to a local path", async () => {
    const asked = await call(worker, req("/schools"));
    expect(asked.headers.get("Location")).toBe("/login?next=%2Fschools");
    const { back } = await portalLogin("alice", testEnv(), "/schools");
    expect(back.headers.get("Location")).toBe("/schools");
    for (const evil of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      const { back: refused } = await portalLogin("alice", testEnv(), evil);
      expect(refused.headers.get("Location")).toBe("/files");
    }
  });

  it("signs out with the form token, everywhere", async () => {
    const { jar } = await portalLogin("alice");
    const { jar: otherBrowser } = await portalLogin("alice");
    const form = { "Content-Type": "application/x-www-form-urlencoded" };
    const forged = await call(worker, req("/logout", jar, { method: "POST", headers: form }));
    expect(forged.status).toBe(403);
    const csrf = await formToken(jar);
    // Each session has its own form token.
    expect(await formToken(otherBrowser)).not.toBe(csrf);
    const out = await call(
      worker,
      req("/logout", jar, { method: "POST", headers: form, body: `csrf=${csrf}` }),
    );
    expect(out.status).toBe(303);
    jar.take(out);
    expect(jar.has("__Host-reef-session")).toBe(false);
    expect((await call(worker, req("/files", jar))).status).toBe(303);
    expect((await call(worker, req("/files", otherBrowser))).status).toBe(303);
    expect((await portalLogin("alice")).back.status).toBe(302);
  });

  it("serves the landing page and 404s elsewhere", async () => {
    expect((await call(worker, req("/"))).status).toBe(200);
    expect((await call(worker, req("/nope"))).status).toBe(404);
  });
});

// ---- MCP OAuth -----------------------------------------------------------------------------

const CLIENT_REDIRECT = "https://client.example/cb";

async function registerClient(): Promise<string> {
  const res = await call(
    worker,
    req("/oauth/register", undefined, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Agent",
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function authorize(clientId: string, verifier: string) {
  const url = new URL(`${ORIGIN}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", CLIENT_REDIRECT);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "client-state");
  url.searchParams.set("resource", `${ORIGIN}/mcp`);
  const jar = new Jar();
  const consent = await call(worker, req(url.toString()));
  expect(consent.status, await consent.clone().text()).toBe(200);
  jar.take(consent);
  const page = await consent.text();
  const handle = page.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
  expect(handle).not.toBe("");
  expect(page).toContain("Test Agent");
  expect(page).toContain("client.example");
  expect(page).toContain("read and send");
  expect(page).toContain("messages in your Reef schools");
  return { jar, handle };
}

function consentPost(jar: Jar, fields: Record<string, string>) {
  return call(
    worker,
    req("/authorize", jar, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  );
}

/** Runs the whole browser flow and returns the authorization code redirect. */
async function signInMcp(githubCode: string) {
  const clientId = await registerClient();
  const verifier = "v".repeat(50);
  const { jar, handle } = await authorize(clientId, verifier);
  const approved = await consentPost(jar, { handle, action: "approve" });
  expect(approved.status, await approved.clone().text()).toBe(302);
  jar.take(approved);
  const github = new URL(approved.headers.get("Location") ?? "");
  expect(github.hostname).toBe("github.test");
  expect(github.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback/mcp`);
  const state = github.searchParams.get("state") ?? "";
  const back = await call(
    worker,
    req(`/auth/callback/mcp?code=${githubCode}&state=${encodeURIComponent(state)}`, jar),
  );
  return { back, clientId, verifier };
}

async function exchange(clientId: string, verifier: string, code: string) {
  const res = await call(
    worker,
    req("/oauth/token", undefined, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: CLIENT_REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }),
    }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

describe("MCP OAuth", () => {
  it("publishes protected-resource metadata for /mcp", async () => {
    const res = await call(worker, req("/.well-known/oauth-protected-resource/mcp"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resource: string }).resource).toBe(`${ORIGIN}/mcp`);
    const unauth = await call(worker, rpcRequest("tools/list"));
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("runs consent, GitHub sign-in and token exchange, then serves the tools", async () => {
    const { back, clientId, verifier } = await signInMcp("alice");
    expect(back.status, await back.clone().text()).toBe(302);
    const redirect = new URL(back.headers.get("Location") ?? "");
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CLIENT_REDIRECT);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    const token = await exchange(clientId, verifier, redirect.searchParams.get("code") ?? "");

    const listed = await readRpc(await call(worker, rpcRequest("tools/list", {}, token)));
    const names = ((listed.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual([
      "create_upload",
      "delete_file",
      "get_download",
      "list_files",
      "school_list",
      "school_read",
      "school_send",
      "school_unread",
      "session_join",
      "share_file",
    ]);

    const joined = await readRpc(
      await call(
        worker,
        rpcRequest(
          "tools/call",
          {
            name: "session_join",
            arguments: { type: "chat", label: "test", product: "test-agent" },
          },
          token,
        ),
      ),
    );
    expect(JSON.stringify(joined.result)).toContain("Session handle: ");

    const created = await readRpc(
      await call(
        worker,
        rpcRequest(
          "tools/call",
          { name: "create_upload", arguments: { name: "a.txt", size: 3 } },
          token,
        ),
      ),
    );
    expect(JSON.stringify(created.result)).toContain("Reef handoff: id=");

    // A ban takes effect on the next request, even with a valid token.
    await env.DB.prepare("UPDATE users SET banned = 1 WHERE id = 101").run();
    const banned = await call(worker, rpcRequest("tools/list", {}, token));
    expect(banned.status).toBe(403);
  });

  it("returns access_denied to the app when the user denies", async () => {
    const clientId = await registerClient();
    const { jar, handle } = await authorize(clientId, "w".repeat(50));
    const denied = await consentPost(jar, { handle, action: "deny" });
    expect(denied.status).toBe(302);
    const redirect = new URL(denied.headers.get("Location") ?? "");
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("client-state");
  });

  it("refuses a consent post without the browser-bound cookie", async () => {
    const clientId = await registerClient();
    const { handle } = await authorize(clientId, "x".repeat(50));
    const res = await consentPost(new Jar(), { handle, action: "approve" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("Location") ?? "").not.toContain("github.test");
  });

  it("refuses accounts without an invite, without issuing a code", async () => {
    const { back } = await signInMcp("mallory");
    expect(back.status).toBe(403);
    expect(back.headers.get("Location")).toBeNull();
  });

  it("refuses a GitHub callback with a forged state", async () => {
    const res = await call(worker, req("/auth/callback/mcp?code=alice&state=forged"));
    expect(res.status).toBe(400);
  });
});

describe("admission", () => {
  it("keeps a banned account out even with an invite", async () => {
    await addUser(102, "bob", true);
    const { back } = await signInMcp("bob");
    expect(back.status).toBe(403);
  });
});

// ---- open signups ----------------------------------------------------------------------------

const DAY = 86_400_000;

/** `count` accounts created at `at`, with IDs from `from`. */
async function seedAccounts(count: number, at: number, from = 1000) {
  await env.DB.batch([
    ...Array.from({ length: count }, (_, i) =>
      env.DB.prepare("INSERT INTO users (id, login, created_at) VALUES (?, ?, ?)").bind(
        from + i,
        `seed${from + i}`,
        at,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO signups_daily (day, created) VALUES (?, ?)
       ON CONFLICT (day) DO UPDATE SET created = created + excluded.created`,
    ).bind(Math.floor(at / DAY), count),
  ]);
}

describe("daily cap on new accounts", () => {
  const open = testEnv({ signupMode: "open" });

  it("refuses a new uninvited account once today's places are taken, saying when to retry", async () => {
    await seedAccounts(MAX_NEW_ACCOUNTS_PER_DAY, Date.now());
    const { back } = await portalLogin("mallory", open);
    expect(back.status).toBe(503);
    const retry = Number(back.headers.get("Retry-After"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(DAY / 1000);
    const tomorrow = new Date(Date.now() - (Date.now() % DAY) + DAY).toISOString().slice(0, 10);
    const body = await back.text();
    expect(body).toContain("as many new accounts as it can today");
    expect(body).toContain(`00:00 UTC on ${tomorrow}`);
    expect(body).toMatch(/invite/);
    expect(back.headers.getSetCookie().join()).not.toContain("__Host-reef-session=");
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = 666").first()).toBeNull();
  });

  it("admits the last place, counting only accounts created since 00:00 UTC", async () => {
    const dayStart = Date.now() - (Date.now() % DAY);
    await seedAccounts(MAX_NEW_ACCOUNTS_PER_DAY, dayStart - 1);
    await seedAccounts(MAX_NEW_ACCOUNTS_PER_DAY - 1, dayStart, 2000);
    const { back } = await portalLogin("mallory", open);
    expect(back.status).toBe(302);
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = 666").first()).not.toBeNull();
  });

  it("doesn't hold back invited logins or existing accounts", async () => {
    await addUser(102, "bob");
    await seedAccounts(MAX_NEW_ACCOUNTS_PER_DAY, Date.now());
    expect((await portalLogin("bob", open)).back.status).toBe(302);
    expect((await portalLogin("alice", open)).back.status).toBe(302);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(count?.n).toBe(MAX_NEW_ACCOUNTS_PER_DAY + 2);
  });

  it("keeps counting an account created today after it is deleted", async () => {
    await seedAccounts(MAX_NEW_ACCOUNTS_PER_DAY - 1, Date.now());
    expect((await portalLogin("mallory", open)).back.status).toBe(302);
    await env.DB.prepare("DELETE FROM users").run();
    expect((await portalLogin("mallory", open)).back.status).toBe(503);
  });
});

describe("account deletion and OAuth", () => {
  it("revokes MCP grants, so an old token stays dead even after signing up again", async () => {
    const { back, clientId, verifier } = await signInMcp("alice");
    const code = new URL(back.headers.get("Location") ?? "").searchParams.get("code") ?? "";
    const token = await exchange(clientId, verifier, code);
    expect((await call(worker, rpcRequest("tools/list", {}, token))).status).toBe(200);

    const { jar } = await portalLogin("alice");
    const deleted = await call(
      worker,
      req("/account/delete", jar, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
        body: new URLSearchParams({ csrf: await formToken(jar), confirm: "ALICE" }),
      }),
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.text()).toContain("Your account is deleted");
    jar.take(deleted);
    expect(jar.has("__Host-reef-session")).toBe(false);
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = 101").first()).toBeNull();

    expect((await call(worker, rpcRequest("tools/list", {}, token))).status).toBe(401);
    // The invite went with the account; in open mode the same GitHub account starts afresh.
    expect((await portalLogin("alice")).back.status).toBe(403);
    expect((await portalLogin("alice", testEnv({ signupMode: "open" }))).back.status).toBe(302);
    expect((await call(worker, rpcRequest("tools/list", {}, token))).status).toBe(401);
  });
});
