#!/usr/bin/env node
// Prints a portal session cookie for local preview, so you can skip GitHub sign-in.
//   node scripts/dev-cookie.mjs 22972550
// Reads COOKIE_SECRET from .dev.vars (or a file named by --vars). The account must exist in
// the local D1 database (scripts/seed-local.sql adds Cobular and unrealJune).
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const varsAt = args.indexOf("--vars");
const varsFile = varsAt >= 0 ? args.splice(varsAt, 2)[1] : ".dev.vars";
const userId = Number(args[0]);
if (!Number.isSafeInteger(userId) || userId <= 0) {
  console.error("Usage: node scripts/dev-cookie.mjs <github-user-id> [--vars .dev.vars]");
  process.exit(1);
}

let secret;
try {
  const line = readFileSync(varsFile, "utf8")
    .split(/\r?\n/)
    .find((l) => /^\s*COOKIE_SECRET\s*=/.test(l));
  secret = line
    ?.slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
} catch {
  console.error(`Could not read ${varsFile}. Copy .dev.vars.example to .dev.vars first.`);
  process.exit(1);
}
if (!secret) {
  console.error(`Set COOKIE_SECRET in ${varsFile} first.`);
  process.exit(1);
}

// Same format as src/auth/signed.ts: base64url(JSON) + "." + base64url(HMAC-SHA256(body)).
const days = 7;
const now = Date.now();
const body = Buffer.from(
  JSON.stringify({ uid: userId, iat: now, p: "session", exp: now + days * 86_400_000 }),
).toString("base64url");
const mac = createHmac("sha256", secret).update(body).digest("base64url");
const value = `${body}.${mac}`;

console.log(value);
console.log("\nIn the browser console on http://localhost:8787:");
console.log(
  `document.cookie = "__Host-reef-session=${value}; Path=/; Secure; SameSite=Lax; Max-Age=${days * 86400}"; location.href = "/files";`,
);
