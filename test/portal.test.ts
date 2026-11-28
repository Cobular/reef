import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { signValue } from "../src/auth/signed";
import { FLASH_COOKIE, SCHOOL_LIMITS, SESSION_COOKIE } from "../src/config";
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
  listSchoolsFor,
  readMessages,
  schoolsContext,
  sendMessage,
  sendPortalMessage,
} from "../src/schools/service";
import {
  addUser,
  call,
  fileRow,
  ORIGIN,
  portalSessionFor,
  resetDb,
  schoolWith,
  TEST_PART_SIZE,
  testEnv,
  testWorker,
} from "./helpers";

const admin = { userId: 22972550, login: "Cobular" };
const bob = { userId: 2, login: "bob" };
const carol = { userId: 3, login: "carol" };
type Who = { userId: number; login: string };

const worker = testWorker();
const workerEnv = testEnv();

/** When this test's sessions were issued (set after the accounts are created). */
let iat = 0;

async function cookieFor(user?: Who, extra = ""): Promise<string> {
  const parts = extra ? [extra] : [];
  if (user) {
    const value = await signValue(
      env.COOKIE_SECRET,
      "session",
      { uid: user.userId, iat },
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
    options.csrf === undefined && user
      ? await csrfToken(workerEnv, user.userId, iat)
      : options.csrf;
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
  iat = Date.now();
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
    expect(body).toContain("Free agent to agent chat");
    expect(body).toContain("Encrypted agent to agent file sharing");
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
      ["/account", bob, "Delete your account"],
    ];
    for (const [path, who, expected] of pages) {
      const res = await get(path, who);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Cache-Control"), path).toContain("no-store");
      const body = await res.text();
      expect(body, path).toContain(expected);
      expect(body, path).toContain(`value="${await csrfToken(workerEnv, who.userId, iat)}"`);
      expectCleanHtml(body);
    }
  });

  it("shows empty states", async () => {
    expect(await (await get("/files", bob)).text()).toContain("Nothing in the water right now.");
    expect(await (await get("/schools", bob)).text()).toContain("You’re not in any schools yet.");
  });

  it("answers HEAD like GET, with no body", async () => {
    const head = async (path: string, user?: Who) =>
      call(
        worker,
        new Request(`${ORIGIN}${path}`, {
          method: "HEAD",
          headers: user ? { Cookie: await cookieFor(user) } : {},
          redirect: "manual",
        }),
        workerEnv,
      );
    for (const [path, user, status] of [
      ["/", undefined, 200],
      ["/files", bob, 200],
      ["/schools", bob, 200],
      ["/files", undefined, 303],
      ["/nowhere", undefined, 404],
    ] as const) {
      const res = await head(path, user);
      expect(res.status, path).toBe(status);
      expect(await res.text(), path).toBe("");
      if (status === 200) {
        expect(res.headers.get("Content-Type"), path).toContain("text/html");
        expect(res.headers.get("Content-Security-Policy"), path).toContain("default-src 'none'");
      }
    }
  });

  it("has a quiet footer, and a folded connect panel with the MCP URL on files and schools", async () => {
    const body = await (await get("/files", bob)).text();
    const footer = body.match(/<footer[^>]*>([\s\S]*?)<\/footer>/)?.[1] ?? "";
    expect(
      [...footer.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[2], m[1]]),
    ).toEqual([
      ["Source", "https://github.com/Cobular/reef"],
      ["Security", "https://github.com/Cobular/reef/security/policy"],
      ["Privacy", "https://cobular.notion.site/Privacy-Policy-277b8e3e484e445193f01fb142529a69"],
      ["Terms", "/terms"],
      ["Report abuse", "https://github.com/Cobular/reef/issues/new?template=abuse-report.yml"],
    ]);
    expect(await (await get("/")).text()).toContain(`<a href="/terms">Terms</a>`);
    expect(body).toContain('<a class="me-link" href="/account"');
    expect(body).not.toContain("foot-mcp");
    expect(body).toContain(`<code id="connect-mcp">${ORIGIN}/mcp</code>`);
    const schools = await (await get("/schools", bob)).text();
    expect(schools).toContain(`<code id="connect-mcp">${ORIGIN}/mcp</code>`);
    expect(body).not.toContain("Files last minutes.</footer>");
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
    const otherToken = await csrfToken(workerEnv, bob.userId, iat);
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
    // Browsers send `Origin: null` on form posts from no-referrer pages; that is refused, so
    // the pages must use a policy that keeps the real origin for same-origin posts.
    expect(
      (await post("/admin/invites/add", admin, { login: "x5" }, { origin: "null" })).status,
    ).toBe(403);
    expect((await get("/admin", admin)).headers.get("Referrer-Policy")).toBe("same-origin");
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

  it("sets apart files from accounts outside your schools", async () => {
    const file = await readyFile(bob, ["Cobular"]);
    const apart = await (await get("/files", admin)).text();
    expect(apart).toContain("From accounts you share no school with (1)");
    expect(apart).toContain("Nothing in the water right now.");
    expect(apart).toContain(`/files/${file.file.id}`);
    await schoolWith([admin.userId, bob.userId]);
    const together = await (await get("/files", admin)).text();
    expect(together).not.toContain("From accounts you share no school with");
    expect(together).toContain(`/files/${file.file.id}`);
  });

  it("names who a file is shared with, and shows expiry as a clock time", async () => {
    await addUser(4, "dave");
    const file = await readyFile(bob, ["Cobular", "carol", "dave"]);
    const list = await (await get("/files", bob)).text();
    expect(list).toContain("<span>Yours</span>");
    expect(list).toContain('<span class="mono">Cobular</span>');
    expect(list).toContain('<span class="mono">carol</span>');
    expect(list).toMatch(/title="(Cobular|carol|dave)">\+1 more<span class="sr-only">: \1<\/span>/);
    expect(await (await get("/files", admin)).text()).toContain("From bob");

    const detail = await (await get(`/files/${file.file.id}`, bob)).text();
    for (const login of ["Cobular", "carol", "dave"])
      expect(detail).toContain(`<span class="mono">${login}</span>`);
    expect(detail).not.toContain(" more<");
    expect(detail).toMatch(
      /<dt>Expires<\/dt><dd><time datetime="[^"]+Z" title="[^"]+ UTC" data-clock>\d\d:\d\d UTC<\/time>/,
    );
    expect(detail).toContain('class="left"');
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
    expect(body).toContain('<li class="msg other"');
    expect(body).not.toContain("another account");
    expect(body).not.toContain("</span>}");
    // The attachment's key rides in a one-click download form, never in a link.
    expect(body).toContain(`<form method="post" action="/files/${file.file.id}/download">`);
    expect(body).toContain(`<input type="hidden" name="key" value="${file.key}">`);
    expect(body).not.toContain(`href="/files/${file.file.id}?`);
    expect((body.match(/href="[^"]*"/g) ?? []).some((h) => h.includes(file.key))).toBe(false);
    const fetched = await post(`/files/${file.file.id}/download`, admin, { key: file.key });
    expect(fetched.status).toBe(200);
    expectCleanHtml(body);

    // Nothing read yet: the divider sits before the first message.
    expect(body.indexOf('class="divider"')).toBeLessThan(body.indexOf("first &lt;script&gt;"));
    await readMessages(ctx, admin.userId, adminSession, school.school.id);
    await sendMessage(ctx, bob.userId, bobSession, school.school.id, "third");
    const after = await (await get(`/schools/${school.school.id}`, admin)).text();
    const divider = after.indexOf('class="divider"');
    expect(divider).toBeGreaterThan(after.indexOf("second"));
    expect(divider).toBeLessThan(after.indexOf("third"));
    // Viewing marks the messages seen for the person, so the next view has no divider...
    const again = await (await get(`/schools/${school.school.id}`, admin)).text();
    expect(again).not.toContain('class="divider"');
    // ...but not for their sessions: the agent still has "third" to read.
    const read = await readMessages(ctx, admin.userId, adminSession, school.school.id);
    expect(read.messages.map((m) => m.text)).toEqual(["third"]);
  });

  it("clears a school's unread badge once the person views it, without touching sessions", async () => {
    const ctx = schoolsContext(workerEnv);
    const school = await createSchool(ctx, bob.userId, "dm", "pair", ["Cobular"]);
    const id = school.school.id;
    await acceptInvite(ctx, admin.userId, id);
    const bobSession = (await joinSession(ctx, bob.userId, "local_coding", "laptop", "claude-code"))
      .handle;
    // Cobular has a session, but it never reads this school (say, a private one).
    const adminSession = (await joinSession(ctx, admin.userId, "chat", "web", "claude-ai")).handle;
    await sendMessage(ctx, bob.userId, bobSession, id, "one");
    await sendMessage(ctx, bob.userId, bobSession, id, "two");
    const badge = (page: string) => page.match(/class="badge" title="(\d+) unread"/)?.[1] ?? null;
    expect(badge(await (await get("/schools", admin)).text())).toBe("2");

    // Viewing the school in the portal clears the badge, and reloading writes nothing new.
    await get(`/schools/${id}`, admin);
    expect(badge(await (await get("/schools", admin)).text())).toBeNull();
    await get(`/schools/${id}`, admin);
    expect((await listSchoolsFor(ctx, admin.userId))[0]?.readSeq).toBe(2);

    // An earlier page doesn't mark newer messages seen.
    await sendMessage(ctx, bob.userId, bobSession, id, "three");
    await get(`/schools/${id}?before=2`, admin);
    expect(badge(await (await get("/schools", admin)).text())).toBe("1");

    // The person's own portal message doesn't leave the badge up once they're back on the page.
    await get(`/schools/${id}`, admin);
    const sent = await post(`/schools/${id}/send`, admin, { text: "mine" });
    await followFlash(sent, admin);
    expect(badge(await (await get("/schools", admin)).text())).toBeNull();

    // The session's own position is untouched: it still has everything to read.
    const read = await readMessages(ctx, admin.userId, adminSession, id);
    expect(read.messages.map((m) => m.text)).toEqual(["one", "two", "three", "mine"]);
  });

  it("sets a display name on the account page, and hides the GitHub face behind it", async () => {
    const ctx = schoolsContext(workerEnv);
    const school = await createSchool(ctx, bob.userId, "dm", "pair", ["Cobular"]);
    await acceptInvite(ctx, admin.userId, school.school.id);
    const refused = await post("/account/name", bob, { name: "Cobular" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("That name is taken");
    const saved = await followFlash(await post("/account/name", bob, { name: "reef-bob" }), bob);
    expect(saved).toContain("Saved. Reef now shows you as reef-bob.");
    expect(saved).toContain('value="reef-bob"');

    const page = await (await get(`/schools/${school.school.id}`, admin)).text();
    expect(page).toContain("reef-bob");
    expect(page).not.toContain(`avatars.githubusercontent.com/u/${bob.userId}?`);
    expect(page).toContain(`avatars.githubusercontent.com/u/${admin.userId}?`);
  });

  it("lists schools as stretched links that say who is in them", async () => {
    const ctx = schoolsContext(workerEnv);
    const pair = await createSchool(ctx, bob.userId, "dm", "pair", ["Cobular"]);
    await acceptInvite(ctx, admin.userId, pair.school.id);
    await createSchool(ctx, bob.userId, "crew", "group", ["carol", "Cobular"]);
    await createSchool(ctx, bob.userId, "mine", "group", []);
    const body = await (await get("/schools", bob)).text();
    expect(body).toContain("With Cobular");
    expect(body).toContain("Group · 3 members");
    expect(body).toContain("Just your sessions");
    expect(body).toContain('<li class="row link">');
    expect(body).not.toContain(">Open</a>");
    expect(await (await get("/schools", admin)).text()).toContain("With bob");
  });

  it("edits the name and description from the school page, with CSRF and inline errors", async () => {
    const ctx = schoolsContext(workerEnv);
    const school = await createSchool(ctx, bob.userId, "crew", "group", ["carol"]);
    const at = `/schools/${school.school.id}`;
    const page = await (await get(at, bob)).text();
    expect(page).toContain(`action="${at}/details"`);
    expect(page).toContain('name="name" value="crew"');
    expect(page).toContain(
      `maxlength="${SCHOOL_LIMITS.maxSchoolDescriptionLength}" aria-describedby="description-hint description-error">\n</textarea>`,
    );
    expect(page).not.toContain('class="school-desc"');
    expectCleanHtml(page);

    const saved = await post(`${at}/details`, bob, {
      name: " Reef crew ",
      description: "Ship <b>it</b>\r\nsecond line",
    });
    expect(saved.headers.get("Location")).toBe(at);
    const after = await followFlash(saved, bob);
    expect(after).toContain("Renamed to Reef crew. Updated the description.");
    expect(after).toContain("<h1>Reef crew</h1>");
    expect(after).toContain('<p class="school-desc">Ship &lt;b&gt;it&lt;/b&gt;\nsecond line</p>');
    expect(after).toContain(">\nShip &lt;b&gt;it&lt;/b&gt;\nsecond line</textarea>");
    expectCleanHtml(after);
    const list = await (await get("/schools", bob)).text();
    expect(list).toContain('<p class="row-desc">Ship &lt;b&gt;it&lt;/b&gt;\nsecond line</p>');

    const same = await post(`${at}/details`, bob, { name: "Reef crew", description: "" });
    expect(await followFlash(same, bob)).toContain("Removed the description.");
    const again = await post(`${at}/details`, bob, { name: "Reef crew", description: "" });
    expect(await followFlash(again, bob)).toContain("Nothing to change.");

    expect((await post(`${at}/details`, bob, { name: "x" }, { csrf: "nope" })).status).toBe(403);
    expect((await post(`${at}/details`, bob, { name: "x" }, { csrf: null })).status).toBe(403);
    const invitee = await post(`${at}/details`, carol, { name: "mine now" });
    expect(await followFlash(invitee, carol)).toContain("Accept the invite");

    const long = "y".repeat(SCHOOL_LIMITS.maxSchoolNameLength + 1);
    const tooLong = await post(`${at}/details`, bob, { name: long, description: "kept" });
    expect(tooLong.status).toBe(400);
    const body = await tooLong.text();
    expect(body).toContain(
      `The name must be 1 to ${SCHOOL_LIMITS.maxSchoolNameLength} characters.`,
    );
    expect(body).toContain(`value="${long}"`);
    expect(body).toContain(">\nkept</textarea>");
    expect(body).toContain('aria-invalid="true"');

    const max = SCHOOL_LIMITS.maxSchoolDescriptionLength;
    const wordy = await post(`${at}/details`, bob, {
      name: "Renamed",
      description: "d".repeat(max + 1),
    });
    expect(wordy.status).toBe(400);
    const wordyBody = await wordy.text();
    expect(wordyBody).toContain(`The description must be at most ${max} characters.`);
    expect(wordyBody).toContain('value="Renamed"');
    expect((await listSchoolsFor(ctx, bob.userId))[0]).toMatchObject({
      name: "Reef crew",
      description: "",
    });
  });

  it("takes an optional description on the new-school form", async () => {
    const created = await post("/schools/new", bob, {
      name: "Helpers",
      kind: "solo",
      description: "  Where my agents ask for help.  ",
    });
    expect(created.status).toBe(303);
    const at = created.headers.get("Location") ?? "";
    expect(await followFlash(created, bob)).toContain(
      '<p class="school-desc">Where my agents ask for help.</p>',
    );
    const list = await (await get("/schools", bob)).text();
    expect(list).toContain('href="/schools/new"');
    expect(list).toContain('<p class="row-desc">Where my agents ask for help.</p>');
    expectCleanHtml(list);
    const form = await (await get("/schools/new", bob)).text();
    expect(form).toContain('id="school-description" name="description"');
    expectCleanHtml(form);

    const max = SCHOOL_LIMITS.maxSchoolDescriptionLength;
    const refused = await post("/schools/new", bob, {
      name: "Wordy",
      kind: "solo",
      description: "<i>".repeat(max),
    });
    expect(refused.status).toBe(400);
    const body = await refused.text();
    expect(body).toContain(`The description must be at most ${max} characters.`);
    expect(body).toContain(">\n&lt;i&gt;&lt;i&gt;");
    expect(body).toContain('value="Wordy"');
    expect((await listSchoolsFor(schoolsContext(workerEnv), bob.userId)).map((s) => s.id)).toEqual([
      at.split("/").pop(),
    ]);
  });

  it("sends from the school page as a person, with CSRF, and keeps refused text", async () => {
    const ctx = schoolsContext(workerEnv);
    const school = await createSchool(ctx, bob.userId, "crew", "group", ["carol", "Cobular"]);
    await acceptInvite(ctx, admin.userId, school.school.id);
    const at = `/schools/${school.school.id}`;
    const page = await (await get(at, bob)).text();
    expect(page).toContain(`action="${at}/send"`);
    expect(page).toContain('name="text"');
    expectCleanHtml(page);
    // Carol has not accepted: no form, and a direct post is refused.
    expect(await (await get(at, carol)).text()).not.toContain(`action="${at}/send"`);
    expect(await followFlash(await post(`${at}/send`, carol, { text: "hi" }), carol)).toContain(
      "Accept the invite",
    );

    expect((await post(`${at}/send`, bob, { text: "hi" }, { csrf: "nope" })).status).toBe(403);
    expect((await post(`${at}/send`, bob, { text: "hi" }, { csrf: null })).status).toBe(403);

    const sent = await post(`${at}/send`, bob, { text: "Hello <team>\r\nsecond line" });
    expect(sent.headers.get("Location")).toBe(`${at}#m1`);
    const after = await followFlash(sent, bob);
    expect(after).toContain("Sent.");
    expect(after).toContain('<li class="msg person" id="m1">');
    expect(after).toContain("In the portal");
    expect(after).toContain("Hello &lt;team&gt;\nsecond line");
    expect(after).not.toContain("reef-portal");
    // Bob's own portal message is not "new" for him; Cobular sees it from another account.
    expect(after).not.toContain('class="divider"');
    const theirs = await (await get(at, admin)).text();
    expect(theirs).toContain('<li class="msg other person" id="m1">');
    expect(theirs).toContain('class="divider"');

    const long = "é".repeat(SCHOOL_LIMITS.maxMessageBytes / 2 + 1);
    const refused = await post(`${at}/send`, bob, { text: long });
    expect(refused.status).toBe(413);
    const body = await refused.text();
    expect(body).toContain("Message too long");
    expect(body).toContain(`${long}</textarea>`);
    expect(body).toContain('aria-invalid="true"');

    await post(`${at}/pause`, bob);
    const paused = await (await get(at, bob)).text();
    expect(paused).not.toContain(`action="${at}/send"`);
    expect(paused).toContain("Sending is off while the school is paused.");
    const blocked = await post(`${at}/send`, bob, { text: "still there?" });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("is paused");
  });

  it("replies from the portal via ?reply=, with CSRF, and links each reply to its parent", async () => {
    const ctx = schoolsContext(workerEnv);
    const school = await createSchool(ctx, bob.userId, "crew", "group", ["Cobular"]);
    const id = school.school.id;
    await acceptInvite(ctx, admin.userId, id);
    const at = `/schools/${id}`;
    const agent = (await joinSession(ctx, admin.userId, "persistent_agent", "iris", "codex"))
      .handle;
    await sendMessage(ctx, admin.userId, agent, id, "Question?");

    const page = await (await get(at, bob)).text();
    expect(page).toContain(`<a class="reply-link" href="${at}?reply=1#compose">Reply`);
    expect(page).toContain('<form class="compose" id="compose"');
    expect(page).not.toContain("Replying to");

    const replying = await (await get(`${at}?reply=1`, bob)).text();
    expect(replying).toContain(
      'Replying to <a href="#m1">#1</a> · <span class="mono">Cobular</span>',
    );
    expect(replying).toContain(`<a href="${at}#compose">Cancel`);
    expect(replying).toContain('<input type="hidden" name="reply_to" value="1">');
    expectCleanHtml(replying);

    const fields = { text: "Answer", reply_to: "1" };
    expect((await post(`${at}/send`, bob, fields, { csrf: "nope" })).status).toBe(403);
    expect((await post(`${at}/send`, bob, fields, { csrf: null })).status).toBe(403);
    const sent = await post(`${at}/send`, bob, fields);
    expect(sent.headers.get("Location")).toBe(`${at}#m2`);
    const after = await followFlash(sent, bob);
    expect(after).toMatch(
      /<li class="msg person" id="m2">[\s\S]*<p class="msg-reply"><a href="#m1">[\s\S]*#1 · <span class="mono">Cobular<\/span><\/a><\/p><p class="msg-text">Answer<\/p>/,
    );
    expect(after).not.toContain("Replying to");

    const missing = await post(`${at}/send`, bob, { text: "Kept", reply_to: "99" });
    expect(missing.status).toBe(400);
    const missingBody = await missing.text();
    expect(missingBody).toContain(`No message with seq 99 in school &quot;crew&quot; (${id})`);
    expect(missingBody).toContain(">\nKept</textarea>");
    expect(missingBody).toContain("Message #99 is no longer in this school");
    expect(missingBody).not.toContain('name="reply_to"');
    const malformed = await post(`${at}/send`, bob, { text: "Kept", reply_to: "1; drop" });
    expect(malformed.status).toBe(400);

    // Fill past one page: the reply's parent (seq 1) is now on an earlier page.
    await env.DB.prepare(
      `WITH RECURSIVE n(seq) AS (SELECT 3 UNION ALL SELECT seq + 1 FROM n WHERE seq < 60)
       INSERT INTO messages (school_id, seq, sender_id, session_type, product, label, text,
         created_at)
       SELECT ?1, seq, ?2, 'persistent_agent', 'codex', 'iris', 'filler', ?3 FROM n`,
    )
      .bind(id, admin.userId, Date.now())
      .run();
    await sendPortalMessage(ctx, bob.userId, id, "Late answer", 1);
    const latest = await (await get(`${at}?reply=1`, bob)).text();
    expect(latest).toContain(`<p class="msg-reply"><a href="${at}?before=2#m1">`);
    expect(latest).toContain(`Replying to <a href="${at}?before=2#m1">#1</a>`);
    expect(await (await get(`${at}?before=2`, bob)).text()).toContain('id="m1"');

    // Retention removed the parent: the reply says so, and new replies to it are refused.
    await env.DB.prepare("DELETE FROM messages WHERE school_id = ? AND seq = 1").bind(id).run();
    const gone = await (await get(`${at}?before=3`, bob)).text();
    expect(gone).toContain("#1 · no longer available</p>");
    expect((await post(`${at}/send`, bob, fields)).status).toBe(400);

    await post(`${at}/pause`, bob);
    expect(await (await get(at, bob)).text()).not.toContain('class="reply-link"');
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
    const other = { ...testEnv(), ADMINS: ` ${bob.userId}, nonsense` } as unknown as Env;
    const asBob = await call(
      worker,
      new Request(`${ORIGIN}/admin`, { headers: { Cookie: await cookieFor(bob) } }),
      other,
    );
    expect(asBob.status).toBe(200);
    // ADMINS holds numeric GitHub IDs; a login there (which another account could take) is ignored.
    const byLogin = { ...testEnv(), ADMINS: bob.login } as unknown as Env;
    const asBobByLogin = await call(
      worker,
      new Request(`${ORIGIN}/admin`, { headers: { Cookie: await cookieFor(bob) } }),
      byLogin,
    );
    expect(asBobByLogin.status).toBe(404);
  });

  it("bans and unbans, but never yourself", async () => {
    const banned = await post("/admin/users/ban", admin, { user: String(bob.userId) });
    expect(await followFlash(banned, admin)).toContain("Banned bob.");
    expect((await get("/files", bob)).status).toBe(303);
    const self = await post("/admin/users/ban", admin, { user: String(admin.userId) });
    expect(await followFlash(self, admin)).toContain("You can’t ban your own account.");
    const unbanned = await post("/admin/users/unban", admin, { user: String(bob.userId) });
    expect(await followFlash(unbanned, admin)).toContain("Unbanned bob.");
    // A session from before the ban stays ended; signing in again works.
    expect((await get("/files", bob)).status).toBe(303);
    const fresh = await portalSessionFor(bob.userId, Date.now() + 1);
    expect((await get("/files", undefined, fresh.cookie)).status).toBe(200);
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

  it("shows whether each invited login has signed up", async () => {
    await addInvite(env.DB, "CAROL", 1);
    await addInvite(env.DB, "NewPerson", 2);
    const invites = await listInvites(env.DB);
    expect(invites.map((i) => [i.login, Boolean(i.joined)])).toEqual([
      ["CAROL", true],
      ["NewPerson", false],
    ]);
    const body = await (await get("/admin", admin)).text();
    expect(body).toMatch(/>CAROL<\/td><td>.*?<\/td><td><span class="pill ready">Joined<\/span>/);
    expect(body).toMatch(
      />NewPerson<\/td><td>.*?<\/td><td><span class="pill expired">Not yet<\/span>/,
    );
  });

  it("repo helpers report what changed", async () => {
    expect(await addInvite(env.DB, "Zed", 1)).toBe(true);
    expect(await addInvite(env.DB, "zed", 2)).toBe(false);
    expect(await removeInvite(env.DB, "ZED")).toBe(true);
    expect(await removeInvite(env.DB, "zed")).toBe(false);
    expect((await setBanned(env.DB, carol.userId, true, Date.now()))?.banned).toBeTruthy();
    expect(await setBanned(env.DB, 999, true, Date.now())).toBeNull();
    expect((await listUsers(env.DB)).map((u) => u.login)).toEqual(
      expect.arrayContaining(["Cobular", "bob", "carol"]),
    );
  });
});

describe("account", () => {
  async function exists(userId: number) {
    return (await listUsers(env.DB)).some((u) => u.id === userId);
  }

  it("deletes the account only with the form token and the login typed out", async () => {
    await readyFile(bob, ["carol"]);
    const page = await (await get("/account", bob)).text();
    expect(page).toContain('aria-current="page"');
    expect(page).toContain('action="/account/delete"');
    expect(page).toContain("It can’t be undone.");

    expect((await post("/account/delete", bob, { confirm: "bob" }, { csrf: null })).status).toBe(
      403,
    );
    expect(
      (await post("/account/delete", bob, { confirm: "bob" }, { origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    const empty = await post("/account/delete", bob, { confirm: " " });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("Type your GitHub login to confirm.");
    const wrong = await post("/account/delete", bob, { confirm: "carol" });
    expect(wrong.status).toBe(400);
    const wrongBody = await wrong.text();
    expect(wrongBody).toContain("That isn’t your GitHub login.");
    expect(wrongBody).toContain('aria-invalid="true"');
    expectCleanHtml(wrongBody);
    expect(await exists(bob.userId)).toBe(true);

    const done = await post("/account/delete", bob, { confirm: " BOB " });
    expect(done.status).toBe(200);
    expect(done.headers.getSetCookie().join()).toMatch(
      new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`, "i"),
    );
    const body = await done.text();
    expect(body).toContain("Your account is deleted");
    expect(body).toContain("with its 1 file and 0 messages");
    expect(body).toContain("Sign in");
    expectCleanHtml(body);
    expect(await exists(bob.userId)).toBe(false);
    // The old session cookie no longer signs anyone in.
    expect((await get("/files", bob)).status).toBe(303);
  });

  it("is signed-in only", async () => {
    expect((await get("/account")).headers.get("Location")).toBe("/login?next=%2Faccount");
    expect((await get("/account/delete", bob)).status).toBe(404);
  });
});

describe("terms", () => {
  it("is public, under the strict CSP, with a last-updated date", async () => {
    const res = await get("/terms");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain("Terms of use");
    expect(body).toContain("2026-11-28");
    expect(body).toContain("A banned account can’t sign in");
    expect(body).toContain('href="/account"');
    expect(body).toContain("https://github.com/Cobular/reef/issues/new?template=abuse-report.yml");
    expectCleanHtml(body);
    expect((await get("/terms", bob)).status).toBe(200);
    expect((await post("/terms", bob)).status).toBe(404);
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

  it("serves /favicon.ico as the SVG favicon", async () => {
    const res = await get("/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(await res.text()).toContain("<svg");
  });

  it("has ASSET_VERSION matching the content (update it when CSS or JS change)", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${CSS}\n${JS}`));
    const expected = bytesToHex(new Uint8Array(digest)).slice(0, 10);
    expect(ASSET_VERSION, `set ASSET_VERSION to "${expected}" in src/portal/assets.ts`).toBe(
      expected,
    );
  });
});
