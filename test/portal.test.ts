import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { signValue } from "../src/auth/signed";
import { FLASH_COOKIE, SESSION_COOKIE } from "../src/config";
import { generateKey } from "../src/files/key";
import { addInvite, listInvites, listUsers, removeInvite, setBanned } from "../src/files/repo";
import { createUpload, filesContext } from "../src/files/service";
import { bytesToHex } from "../src/lib/base64";
import { ASSET_URLS, ASSET_VERSION, CSS, JS } from "../src/portal/assets";
import { csrfToken } from "../src/portal/csrf";
import {
  acceptInvite,
  createSchool,
  inviteToSchool,
  joinSession,
  schoolsContext,
  sendMessage,
} from "../src/schools/service";
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

const admin = { userId: 1, login: "Cobular" };
const bob = { userId: 2, login: "bob" };
const carol = { userId: 3, login: "carol" };
type Who = { userId: number; login: string };

const worker = testWorker();
const workerEnv = testEnv();

async function cookieFor(user?: Who, extra = ""): Promise<string> {
  const parts = extra ? [extra] : [];
  if (user) {
    const value = await signValue(
      env.COOKIE_SECRET,
      "session",
      { uid: user.userId },
      Date.now() + 3_600_000,
    );
    parts.push(`${SESSION_COOKIE}=${value}`);
  }
  return parts.join("; ");
}

async function get(path: string, user?: Who, cookie = ""): Promise<Response> {
  const headers = new Headers();
  const jar = await cookieFor(user, cookie);
  if (jar) headers.set("Cookie", jar);
  return call(worker, new Request(`${ORIGIN}${path}`, { headers, redirect: "manual" }), workerEnv);
}

interface PostOptions {
  csrf?: string | null;
  origin?: string | null;
  accept?: string;
}

async function post(
  path: string,
  user: Who | undefined,
  fields: Record<string, string | string[]> = {},
  options: PostOptions = {},
): Promise<Response> {
  const body = new URLSearchParams();
  const token =
    options.csrf === undefined && user ? await csrfToken(workerEnv, user.userId) : options.csrf;
  if (token) body.set("csrf", token);
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  const jar = await cookieFor(user);
  if (jar) headers.set("Cookie", jar);
  if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN);
  if (options.accept) headers.set("Accept", options.accept);
  return call(
    worker,
    new Request(`${ORIGIN}${path}`, { method: "POST", headers, body, redirect: "manual" }),
    workerEnv,
  );
}

/** A flash set by a 303, as a Cookie header for the next request. */
function flashOf(response: Response): string {
  const line = response.headers.getSetCookie().find((c) => c.startsWith(`${FLASH_COOKIE}=`));
  return line?.split(";")[0] ?? "";
}

async function followFlash(response: Response, user: Who): Promise<string> {
  expect(response.status).toBe(303);
  const page = await get(response.headers.get("Location") ?? "/", user, flashOf(response));
  return page.text();
}

function bytes(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);
}

/** A ready file owned by `owner`, uploaded through /up like a real client. */
async function readyFile(owner: Who, shareWith: string[] = [], name = "notes.txt", size = 64) {
  const up = await createUpload(filesContext(workerEnv, TEST_PART_SIZE), owner, {
    name,
    size,
    share_with: shareWith,
  });
  const body = bytes(size);
  const put = await call(
    worker,
    new Request(`${ORIGIN}/up/${up.token}`, {
      method: "PUT",
      headers: { "X-Key": up.key, "Content-Length": String(size) },
      body,
    }),
    workerEnv,
  );
  expect(put.status).toBe(200);
  return { ...up, body };
}

function expectCleanHtml(body: string) {
  expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(body).not.toMatch(/\sstyle=/i);
}

beforeEach(async () => {
  await resetDb();
  await addUser(admin.userId, admin.login);
  await addUser(bob.userId, bob.login);
  await addUser(carol.userId, carol.login);
});

describe("pages and headers", () => {
  it("serves the landing page signed out, and sends signed-in visitors to their files", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    const body = await res.text();
    expect(body).toContain("Hand files and messages between AI agent sessions.");
    expect(body).toContain("Sign in with GitHub");
    expect(body).toContain(`${ORIGIN}/mcp`);
    expect(body).toContain(ASSET_URLS.css);
    expectCleanHtml(body);

    const signedIn = await get("/", bob);
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("Location")).toBe("/files");
  });

  it("renders every signed-in screen without inline script or style", async () => {
    const file = await readyFile(bob, ["Cobular"]);
    const school = await createSchool(schoolsContext(workerEnv), bob.userId, "dm", "pair", [
      "Cobular",
    ]);
    const pages: [string, Who, string][] = [
      ["/files", bob, "notes.txt"],
      ["/files", admin, "From bob"],
      ["/files/new", bob, "Upload a file"],
      [`/files/${file.file.id}`, admin, "Download"],
      ["/schools", admin, "Invitations"],
      [`/schools/${school.school.id}`, admin, "invited you to this school."],
      [`/schools/${school.school.id}`, bob, "dm"],
      ["/admin", admin, "Accounts"],
    ];
    for (const [path, who, expected] of pages) {
      const res = await get(path, who);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Cache-Control"), path).toContain("no-store");
      const body = await res.text();
      expect(body, path).toContain(expected);
      expect(body, path).toContain(`value="${await csrfToken(workerEnv, who.userId)}"`);
      expectCleanHtml(body);
    }
  });

  it("shows empty states", async () => {
    expect(await (await get("/files", bob)).text()).toContain("Nothing in the water right now.");
    expect(await (await get("/schools", bob)).text()).toContain("You’re not in any schools yet.");
  });

  it("sends signed-out visitors to sign in and back, and 404s unknown pages", async () => {
    const files = await get("/files/abc?x=1");
    expect(files.status).toBe(303);
    expect(files.headers.get("Location")).toBe(
      `/login?next=${encodeURIComponent("/files/abc?x=1")}`,
    );
    const action = await post("/schools/abc/leave", undefined);
    expect(action.headers.get("Location")).toBe(
      `/login?next=${encodeURIComponent("/schools/abc")}`,
    );
    const json = await post("/files/new", undefined, {}, { accept: "application/json" });
    expect(json.status).toBe(401);
    expect((await get("/nope", bob)).status).toBe(404);
    expect((await get("/files/abc/def", bob)).status).toBe(404);
  });

  it("shows a flash once", async () => {
    const res = await post("/admin/invites/add", admin, { login: "newbie" });
    const flash = flashOf(res);
    expect(flash).not.toBe("");
    const page = await get("/admin", admin, flash);
    expect(await page.text()).toContain("Invited newbie.");
    expect(page.headers.getSetCookie().join()).toMatch(
      new RegExp(`${FLASH_COOKIE}=;.*Max-Age=0`, "i"),
    );
    const forged = `${FLASH_COOKIE}=${flash.split("=")[1]?.slice(0, -2)}xx`;
    expect(await (await get("/admin", admin, forged)).text()).not.toContain("Invited newbie.");
  });
});

describe("CSRF", () => {
  it("refuses posts without the token, with the wrong token, or from another origin", async () => {
    const before = (await listInvites(env.DB)).length;
    expect((await post("/admin/invites/add", admin, { login: "x1" }, { csrf: null })).status).toBe(
      403,
    );
    const otherToken = await csrfToken(workerEnv, bob.userId);
    expect(
      (await post("/admin/invites/add", admin, { login: "x2" }, { csrf: otherToken })).status,
    ).toBe(403);
    const crossSite = await post(
      "/admin/invites/add",
      admin,
      { login: "x3" },
      { origin: "https://evil.example" },
    );
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).toContain("That form has expired");
    expect((await listInvites(env.DB)).length).toBe(before);
    // No Origin header at all (some privacy settings strip it) still works with the token.
    expect(
      (await post("/admin/invites/add", admin, { login: "x4" }, { origin: null })).status,
    ).toBe(303);
  });
});

describe("browser upload", () => {
  const json = { accept: "application/json" };

  it("creates an upload and returns what the page script needs", async () => {
    const res = await post(
      "/files/new",
      bob,
      {
        name: "report.pdf",
        size: "2048",
        lifetime: "15",
        download_limit: "2",
        share_with: "Cobular",
      },
      json,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "report.pdf",
      parts: 1,
      partSize: TEST_PART_SIZE,
      lifetimeMinutes: 15,
      shareWith: ["Cobular"],
    });
    expect(body.handoff).toContain(`id=${body.fileId}`);
    expect(body.handoff).toContain(`key=${body.key}`);
    const row = await fileRow(body.fileId as string);
    expect(row?.state).toBe("pending");
  });

  it("puts each refusal next to the field it is about", async () => {
    const base = { name: "a.txt", size: "10", lifetime: "10" };
    const cases: [Record<string, string>, string, number][] = [
      [{ share_with: "nobody-here" }, "share_with", 400],
      [{ download_limit: "0" }, "download_limit", 400],
      [{ download_limit: "two" }, "download_limit", 400],
      [{ lifetime: "7" }, "lifetime", 400],
      [{ name: "" }, "file", 400],
    ];
    for (const [fields, field, status] of cases) {
      const res = await post("/files/new", bob, { ...base, ...fields }, json);
      expect(res.status, field).toBe(status);
      const body = (await res.json()) as { error: { field: string; message: string } };
      expect(body.error.field, JSON.stringify(fields)).toBe(field);
      expect(body.error.message.length).toBeGreaterThan(0);
    }
    const forged = await post("/files/new", bob, base, { ...json, csrf: "nope" });
    expect(forged.status).toBe(403);
  });
});

describe("file detail and download", () => {
  it("streams the file for the right key or handoff line, and refuses a wrong one inline", async () => {
    const file = await readyFile(bob, ["Cobular"], "notes.txt", 64);
    const path = `/files/${file.file.id}/download`;

    const byKey = await post(path, admin, { key: file.key });
    expect(byKey.status).toBe(200);
    expect(byKey.headers.get("Content-Disposition")).toContain("notes.txt");
    expect(new Uint8Array(await byKey.arrayBuffer())).toEqual(file.body);

    const byLine = await post(path, admin, { key: `  ${file.handoff}\n` });
    expect(byLine.status).toBe(200);
    await byLine.arrayBuffer();

    const wrong = await post(path, admin, { key: generateKey() });
    expect(wrong.status).toBe(403);
    const wrongBody = await wrong.text();
    expect(wrongBody).toContain("That key doesn’t match this file.");
    expect(wrongBody).toContain('aria-invalid="true"');

    const other = await readyFile(bob, [], "other.txt");
    const mismatch = await post(path, admin, { key: other.handoff });
    expect(await mismatch.text()).toContain("That handoff line is for a different file.");

    expect((await post(path, admin, { key: "not a key" })).status).toBe(400);
  });

  it("tells outsiders and late arrivals the file has swum off", async () => {
    const file = await readyFile(bob);
    const outsider = await get(`/files/${file.file.id}`, carol);
    expect(outsider.status).toBe(404);
    expect(await outsider.text()).toContain("This file has swum off.");
    expect((await post(`/files/${file.file.id}/download`, carol, { key: file.key })).status).toBe(
      404,
    );

    await env.DB.prepare("UPDATE files SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 60_000, file.file.id)
      .run();
    const late = await get(`/files/${file.file.id}`, bob);
    expect(late.status).toBe(410);
    expect(await late.text()).toContain("This file has swum off.");
  });

  it("lets the owner share, and anyone on the list delete", async () => {
    const file = await readyFile(bob);
    const shared = await post(`/files/${file.file.id}/share`, bob, { add: "carol" });
    expect(await followFlash(shared, bob)).toContain("carol");
    expect((await get(`/files/${file.file.id}`, carol)).status).toBe(200);

    const notOwner = await post(`/files/${file.file.id}/share`, carol, { add: "Cobular" });
    expect(notOwner.status).toBe(403);

    const deleted = await post(`/files/${file.file.id}/delete`, carol, { back: "//evil.example" });
    expect(deleted.headers.get("Location")).toBe("/files");
    expect(await followFlash(deleted, carol)).toContain("Deleted notes.txt for everyone.");
    expect((await fileRow(file.file.id))?.state).toBe("deleted");
  });
});

describe("schools", () => {
  it("creates, accepts, sets types, pauses, resumes, invites and leaves", async () => {
    const created = await post("/schools/new", bob, {
      name: "Pairing",
      kind: "pair",
      logins: "Cobular",
    });
    expect(created.status).toBe(303);
    const at = created.headers.get("Location") ?? "";
    expect(at).toMatch(/^\/schools\/[a-z0-9]+$/);
    expect(await followFlash(created, bob)).toContain("Created Pairing. Invited Cobular.");

    const accepted = await post(`${at}/accept`, admin);
    expect(await followFlash(accepted, admin)).toContain("You joined Pairing.");

    const types = await post(`${at}/types`, admin, { types: ["chat", "local_coding"] });
    expect(types.status).toBe(303);
    const row = await env.DB.prepare("SELECT session_types FROM school_members WHERE user_id = ?")
      .bind(admin.userId)
      .first<{ session_types: string }>();
    expect(JSON.parse(row?.session_types ?? "[]")).toEqual(["chat", "local_coding"]);

    const paused = await post(`${at}/pause`, bob);
    expect(await followFlash(paused, bob)).toContain("School’s out.");
    await post(`${at}/resume`, admin);
    expect(await (await get(at, bob)).text()).not.toContain("School’s out.");

    const full = await post(`${at}/invite`, bob, { logins: "carol" });
    expect(await followFlash(full, bob)).toMatch(/pair/i);

    const left = await post(`${at}/leave`, bob);
    expect(left.headers.get("Location")).toBe("/schools");
    expect(await followFlash(left, bob)).toContain("You left Pairing.");
    expect((await get(at, bob)).status).toBe(404);
  });

  it("solo schools have no invitees; declining removes the invite", async () => {
    const solo = await post("/schools/new", bob, { name: "Mine", kind: "solo", logins: "carol" });
    expect(await followFlash(solo, bob)).toContain("Created Mine.");
    const group = await createSchool(schoolsContext(workerEnv), bob.userId, "crew", "group", [
      "carol",
    ]);
    const declined = await post(`/schools/${group.school.id}/decline`, carol);
    expect(declined.headers.get("Location")).toBe("/schools");
    expect((await get(`/schools/${group.school.id}`, carol)).status).toBe(404);
  });

  it("re-renders the new-school form with inline errors", async () => {
    const res = await post("/schools/new", bob, {
      name: "x",
      kind: "pair",
      logins: "carol Cobular",
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("A pair school has exactly one other person.");
    expect(body).toContain('value="carol Cobular"');
    const unknown = await post("/schools/new", bob, { name: "x", kind: "group", logins: "ghost" });
    expect(await unknown.text()).toContain("ghost");
  });

  it("shows the transcript oldest first, escaped, with attachments", async () => {
    const ctx = schoolsContext(workerEnv);
    const school = await createSchool(ctx, bob.userId, "dm", "pair", ["Cobular"]);
    await acceptInvite(ctx, admin.userId, school.school.id);
    const bobSession = (await joinSession(ctx, bob.userId, "local_coding", "laptop", "claude-code"))
      .handle;
    const adminSession = (await joinSession(ctx, admin.userId, "chat", "web", "claude-ai")).handle;
    const file = await readyFile(bob, ["Cobular"], "diagram.png");
    await sendMessage(
      ctx,
      bob.userId,
      bobSession,
      school.school.id,
      "first <script>alert(1)</script>",
      [{ file_id: file.file.id, key: file.key }],
    );
    await sendMessage(ctx, admin.userId, adminSession, school.school.id, "second");
    const body = await (await get(`/schools/${school.school.id}`, admin)).text();
    expect(body.indexOf("first &lt;script&gt;")).toBeGreaterThan(-1);
    expect(body.indexOf("first &lt;script&gt;")).toBeLessThan(body.indexOf("second"));
    expect(body).toContain("diagram.png");
    expect(body).toContain(`/files/${file.file.id}`);
    expect(body).toContain("another account");
    expectCleanHtml(body);
  });

  it("only invites into a group with room, from the page", async () => {
    const ctx = schoolsContext(workerEnv);
    const school = await createSchool(ctx, bob.userId, "crew", "group", []);
    const res = await post(`/schools/${school.school.id}/invite`, bob, {
      logins: "carol, Cobular",
    });
    expect(await followFlash(res, bob)).toContain("Invited");
    const again = await inviteToSchool(ctx, bob.userId, school.school.id, ["carol"]);
    expect(again.invited).toEqual([]);
  });
});

describe("admin", () => {
  it("is a 404 for everyone but admins", async () => {
    expect((await get("/admin", bob)).status).toBe(404);
    expect((await post("/admin/users/ban", bob, { user: "3" })).status).toBe(404);
    expect((await get("/admin")).status).toBe(303);
    const other = { ...testEnv(), ADMINS: "bob" } as unknown as Env;
    const asBob = await call(
      worker,
      new Request(`${ORIGIN}/admin`, { headers: { Cookie: await cookieFor(bob) } }),
      other,
    );
    expect(asBob.status).toBe(200);
  });

  it("bans and unbans, but never yourself", async () => {
    const banned = await post("/admin/users/ban", admin, { user: String(bob.userId) });
    expect(await followFlash(banned, admin)).toContain("Banned bob.");
    expect((await get("/files", bob)).status).toBe(303);
    const self = await post("/admin/users/ban", admin, { user: String(admin.userId) });
    expect(await followFlash(self, admin)).toContain("You can’t ban your own account.");
    const unbanned = await post("/admin/users/unban", admin, { user: String(bob.userId) });
    expect(await followFlash(unbanned, admin)).toContain("Unbanned bob.");
    expect((await get("/files", bob)).status).toBe(200);
  });

  it("adds and removes invites and deletes files by ID", async () => {
    await post("/admin/invites/add", admin, { login: "@NewPerson" });
    expect((await listInvites(env.DB)).map((i) => i.login)).toContain("NewPerson");
    const dup = await post("/admin/invites/add", admin, { login: "newperson" });
    expect(await followFlash(dup, admin)).toContain("already invited");
    const bad = await post("/admin/invites/add", admin, { login: "not a login" });
    expect(await followFlash(bad, admin)).toContain("Enter a GitHub login");
    await post("/admin/invites/remove", admin, { login: "NewPerson" });
    expect((await listInvites(env.DB)).map((i) => i.login)).not.toContain("NewPerson");

    const file = await readyFile(bob);
    const del = await post("/admin/files/delete", admin, { id: file.file.id });
    expect(await followFlash(del, admin)).toContain(`Deleted notes.txt (${file.file.id})`);
    expect((await fileRow(file.file.id))?.state).toBe("deleted");
    const missing = await post("/admin/files/delete", admin, { id: file.file.id });
    expect(await followFlash(missing, admin)).toContain("No live file has the ID");
  });

  it("repo helpers report what changed", async () => {
    expect(await addInvite(env.DB, "Zed", 1)).toBe(true);
    expect(await addInvite(env.DB, "zed", 2)).toBe(false);
    expect(await removeInvite(env.DB, "ZED")).toBe(true);
    expect(await removeInvite(env.DB, "zed")).toBe(false);
    expect((await setBanned(env.DB, carol.userId, true))?.banned).toBeTruthy();
    expect(await setBanned(env.DB, 999, true)).toBeNull();
    expect((await listUsers(env.DB)).map((u) => u.login)).toEqual(
      expect.arrayContaining(["Cobular", "bob", "carol"]),
    );
  });
});

describe("static assets", () => {
  it("serves versioned assets immutably and 404s other versions", async () => {
    for (const [url, type] of [
      [ASSET_URLS.css, "text/css"],
      [ASSET_URLS.js, "javascript"],
      [ASSET_URLS.favicon, "image/svg+xml"],
    ] as const) {
      const res = await get(url);
      expect(res.status, url).toBe(200);
      expect(res.headers.get("Content-Type"), url).toContain(type);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    expect((await get("/static/portal.0000000000.css")).status).toBe(404);
  });

  it("has ASSET_VERSION matching the content (update it when CSS or JS change)", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${CSS}\n${JS}`));
    const expected = bytesToHex(new Uint8Array(digest)).slice(0, 10);
    expect(ASSET_VERSION, `set ASSET_VERSION to "${expected}" in src/portal/assets.ts`).toBe(
      expected,
    );
  });
});
