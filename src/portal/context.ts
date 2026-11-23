import { type PortalSession, portalSession } from "../auth/portal";
import { signValue, verifyValue } from "../auth/signed";
import { FLASH_COOKIE, FLASH_TTL_SECONDS, isAdmin, MAX_FORM_BODY_BYTES } from "../config";
import { clearCookie, getCookie, setCookie } from "../lib/http";
import { csrfOk, csrfToken } from "./csrf";

export type FlashKind = "ok" | "info" | "warn" | "error";

export interface Flash {
  kind: FlashKind;
  message: string;
}

/** Everything a portal page needs about the request, built once per request. */
export interface Portal {
  request: Request;
  env: Env;
  url: URL;
  now: number;
  user: PortalSession | null;
  csrf: string | null;
  admin: boolean;
  flash: Flash | null;
  partSize: number;
}

export interface SignedIn extends Portal {
  user: PortalSession;
  csrf: string;
}

export async function portalContext(
  request: Request,
  env: Env,
  partSize: number,
  now = Date.now(),
): Promise<Portal> {
  const user = await portalSession(request, env);
  const flashData = await verifyValue(
    env.COOKIE_SECRET,
    "flash",
    getCookie(request, FLASH_COOKIE),
    now,
  );
  const flash =
    flashData && typeof flashData.m === "string" && typeof flashData.k === "string"
      ? { kind: flashData.k as FlashKind, message: flashData.m }
      : null;
  return {
    request,
    env,
    url: new URL(request.url),
    now,
    user,
    csrf: user ? await csrfToken(env, user.userId) : null,
    admin: user ? isAdmin(env, user.login) : false,
    flash,
    partSize,
  };
}

/** The cookie that clears a flash once a page has shown it. */
export function flashClear(p: Portal): string | null {
  return p.flash ? clearCookie(FLASH_COOKIE) : null;
}

/** 303 See Other to `location`, with a one-time message for the next page. */
export async function seeOther(
  p: Portal,
  location: string,
  message?: string,
  kind: FlashKind = "ok",
): Promise<Response> {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (message) {
    const value = await signValue(
      p.env.COOKIE_SECRET,
      "flash",
      { m: message, k: kind },
      p.now + FLASH_TTL_SECONDS * 1000,
    );
    headers.append("Set-Cookie", setCookie(FLASH_COOKIE, value, FLASH_TTL_SECONDS));
  }
  return new Response(null, { status: 303, headers });
}

/** A posted form (urlencoded, small) or null if it is not one. The Worker refuses larger bodies with 413 first. */
export async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_FORM_BODY_BYTES) return null;
  const body = await request.text();
  if (body.length > MAX_FORM_BODY_BYTES) return null;
  return new URLSearchParams(body);
}

/** True if the form carries a valid CSRF token for the signed-in account. */
export function formCsrfOk(p: SignedIn, form: URLSearchParams | null): boolean {
  return csrfOk(p.request, p.env, p.csrf, form?.get("csrf") ?? null);
}

/** Splits "alice, bob carol" into logins. */
export function loginList(value: string | null): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((l) => l.trim())
    .filter(Boolean);
}
