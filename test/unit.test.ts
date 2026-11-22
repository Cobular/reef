// Unit tests for the pure helpers. (This file began as the SSE-C spike; it should be renamed
// to unit.test.ts. The subagent that wrote it could not rename or delete files.)
import { describe, expect, it } from "vitest";
import { signValue, verifyValue } from "../src/auth/signed";
import {
  downloadCommand,
  fileNameProblem,
  multipartPython,
  multipartScript,
  shellQuote,
  uploadCommand,
} from "../src/files/commands";
import { generateKey, parseKey } from "../src/files/key";
import { parseRange } from "../src/files/range";
import { Storage, WrongKeyError } from "../src/files/storage";
import { issueToken, verifyToken } from "../src/files/tokens";
import { escapeHtml, html } from "../src/lib/html";
import { sanitize } from "../src/lib/log";
import { ssecBucket } from "./helpers";

const SECRET = "unit-test-secret";

describe("file tokens", () => {
  it("round-trips and binds action, file and user", async () => {
    const now = Date.now();
    const token = await issueToken(SECRET, "dl", "abc", 7, now);
    expect(await verifyToken(SECRET, token, "dl", now)).toMatchObject({
      fileId: "abc",
      userId: 7,
      action: "dl",
    });
    expect(await verifyToken(SECRET, token, "up", now)).toBeNull();
    expect(await verifyToken("other-secret", token, "dl", now)).toBeNull();
  });

  it("expires: download tokens after 60 s, upload tokens after 30 min", async () => {
    const now = Date.now();
    const dl = await issueToken(SECRET, "dl", "abc", 7, now);
    expect(await verifyToken(SECRET, dl, "dl", now + 59_000)).not.toBeNull();
    expect(await verifyToken(SECRET, dl, "dl", now + 61_000)).toBeNull();
    const up = await issueToken(SECRET, "up", "abc", 7, now);
    expect(await verifyToken(SECRET, up, "up", now + 29 * 60_000)).not.toBeNull();
    expect(await verifyToken(SECRET, up, "up", now + 31 * 60_000)).toBeNull();
  });

  it("rejects tampered payloads and junk", async () => {
    const now = Date.now();
    const token = await issueToken(SECRET, "dl", "abc", 7, now);
    const [, sig] = token.split(".");
    const forged = `${btoa(JSON.stringify({ f: "xyz", a: "dl", u: 7, e: now + 60_000 })).replace(/=+$/, "")}.${sig}`;
    expect(await verifyToken(SECRET, forged, "dl", now)).toBeNull();
    for (const junk of ["", ".", "abc", "a.b.c", `${token}x`]) {
      expect(await verifyToken(SECRET, junk, "dl", now)).toBeNull();
    }
  });
});

describe("signed cookie values", () => {
  it("checks purpose, signature and expiry", async () => {
    const now = Date.now();
    const value = await signValue(SECRET, "session", { uid: 1 }, now + 1000);
    expect(await verifyValue(SECRET, "session", value, now)).toMatchObject({ uid: 1 });
    expect(await verifyValue(SECRET, "login", value, now)).toBeNull();
    expect(await verifyValue(SECRET, "session", value, now + 2000)).toBeNull();
    expect(await verifyValue("other", "session", value, now)).toBeNull();
    expect(await verifyValue(SECRET, "session", null, now)).toBeNull();
  });
});

describe("keys", () => {
  it("accepts exactly 32 bytes of base64", () => {
    const key = generateKey();
    expect(parseKey(key)?.byteLength).toBe(32);
    expect(parseKey(btoa("x".repeat(31)))).toBeNull();
    expect(parseKey(btoa("x".repeat(33)))).toBeNull();
    expect(parseKey("not base64!!")).toBeNull();
    expect(parseKey(null)).toBeNull();
  });
});

describe("ranges", () => {
  it("parses single ranges and flags unsatisfiable ones", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=-5", 100)).toEqual({ offset: 95, length: 5 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

describe("commands", () => {
  it("quotes names so a hostile name cannot break out of the command", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const cmd = uploadCommand("https://r.example", "tok", "KEY=", "a'; rm -rf ~ #");
    expect(cmd).toBe(
      `curl -sS --fail-with-body -T 'a'\\''; rm -rf ~ #' -H 'X-Key: KEY=' 'https://r.example/up/tok'`,
    );
    expect(downloadCommand("https://r.example", "tok", "x.txt")).toBe(
      `curl -sSf -H 'X-Key: <key>' -o 'x.txt' 'https://r.example/dl/tok'`,
    );
  });

  it("rejects names that are paths or carry control characters", () => {
    expect(fileNameProblem("report.pdf")).toBeNull();
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\nb", " a", "x".repeat(256)]) {
      expect(fileNameProblem(bad)).not.toBeNull();
    }
  });

  it("cuts parts on the configured part size and checks the file size first", () => {
    const mib = 1024 * 1024;
    const script = multipartScript("https://r.example", "tok", "K", "big.bin", 200 * mib, 90 * mib);
    expect(script.startsWith("(")).toBe(true);
    expect(script.endsWith(")")).toBe(true);
    expect(script).toContain("SIZE=209715200; N=3");
    expect(script).toContain("bs=1048576 skip=$(( (i - 1) * 90 )) count=90");
    expect(script).toContain(`curl -sS --fail-with-body --retry 3 -T "$T"`);
    expect(script).toContain(`"$U/complete"`);
    const odd = multipartScript("https://r.example", "tok", "K", "b", 10_000, 4_000);
    expect(odd).toContain("bs=4000 skip=$(( i - 1 )) count=1");
    const py = multipartPython("https://r.example", "tok", "K", `we"ird.bin`, 90 * mib);
    expect(py).toContain(`F = "we\\"ird.bin"`);
    expect(py).toContain("P = 94371840");
  });
});

describe("html and logs", () => {
  it("escapes interpolated values", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    expect(html`<p>${"<script>"}</p>`.value).toBe("<p>&lt;script&gt;</p>");
  });

  it("drops secret-looking fields from log lines", () => {
    const clean = sanitize({
      file: "abc",
      user: 1,
      key: "k",
      token: "t",
      authorization: "a",
      cookie: "c",
      note: "x".repeat(500),
    });
    expect(Object.keys(clean).sort()).toEqual(["file", "note", "user"]);
    expect(String(clean.note).length).toBeLessThanOrEqual(201);
  });
});

describe("storage with SSE-C", () => {
  // Miniflare ignores ssecKey; ssecBucket emulates R2's refusal of a wrong key.
  const storage = new Storage(ssecBucket());
  const key = parseKey(generateKey()) as ArrayBuffer;
  const other = parseKey(generateKey()) as ArrayBuffer;

  it("reads back with the right key and refuses the wrong one", async () => {
    await storage.put("unit1", new TextEncoder().encode("hello").buffer as ArrayBuffer, key);
    const object = await storage.get("unit1", key);
    expect(await object?.text()).toBe("hello");
    await expect(storage.get("unit1", other)).rejects.toBeInstanceOf(WrongKeyError);
    expect(await storage.get("missing", key)).toBeNull();
  });
});
