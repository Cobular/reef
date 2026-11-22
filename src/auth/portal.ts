import {
  PORTAL_STATE_COOKIE,
  publicOrigin,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  STATE_TTL_SECONDS,
} from "../config";
import { getUser } from "../files/repo";
import { randomToken, timingSafeEqualStrings } from "../lib/crypto";
import { errorPage } from "../lib/html";
import { clearCookie, getCookie, redirect, safeNext, setCookie } from "../lib/http";
import { logError } from "../lib/log";
import { type GitHubApi, pkceChallenge } from "./github";
import { signValue, verifyValue } from "./signed";
import { admit, refusalPage } from "./signup";

export const PORTAL_CALLBACK_PATH = "/auth/callback/portal";

export interface PortalSession {
  userId: number;
  login: string;
}

/** Reads the session cookie and rechecks the account, so a ban takes effect at once. */
export async function portalSession(request: Request, env: Env): Promise<PortalSession | null> {
  const data = await verifyValue(env.COOKIE_SECRET, "session", getCookie(request, SESSION_COOKIE));
  if (!data || typeof data.uid !== "number") return null;
  const user = await getUser(env.DB, data.uid);
  if (!user || user.banned) return null;
  return { userId: user.id, login: user.login };
}

/**
 * GET /login: start GitHub sign-in with a signed, short-lived state + PKCE cookie. `next` (a
 * same-origin path, already checked with `safeNext`) rides in the cookie to the callback.
 */
export async function startLogin(
  env: Env,
  github: GitHubApi,
  next: string | null = null,
): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken();
  const cookie = await signValue(
    env.COOKIE_SECRET,
    "login",
    { s: state, v: verifier, ...(next ? { n: next } : {}) },
    Date.now() + STATE_TTL_SECONDS * 1000,
  );
  const location = github.authorizeUrl({
    clientId: env.GITHUB_CLIENT_ID,
    redirectUri: `${publicOrigin(env)}${PORTAL_CALLBACK_PATH}`,
    state,
    codeChallenge: await pkceChallenge(verifier),
  });
  return redirect(location, {
    "Set-Cookie": setCookie(PORTAL_STATE_COOKIE, cookie, STATE_TTL_SECONDS),
  });
}

/** GET /auth/callback/portal: check state (CSRF), sign in through the signup gate, set the session. */
export async function finishLogin(
  request: Request,
  env: Env,
  github: GitHubApi,
): Promise<Response> {
  const url = new URL(request.url);
  const saved = await verifyValue(
    env.COOKIE_SECRET,
    "login",
    getCookie(request, PORTAL_STATE_COOKIE),
  );
  const state = url.searchParams.get("state");
  const clear = { "Set-Cookie": clearCookie(PORTAL_STATE_COOKIE) };
  if (
    !saved ||
    typeof saved.s !== "string" ||
    typeof saved.v !== "string" ||
    !state ||
    !timingSafeEqualStrings(saved.s, state)
  ) {
    return withHeaders(
      errorPage(
        400,
        "Sign-in expired",
        "This sign-in link is invalid or has expired. Start again.",
      ),
      clear,
    );
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return withHeaders(errorPage(400, "Sign-in cancelled", "GitHub sign-in was cancelled."), clear);
  }
  let user: Awaited<ReturnType<GitHubApi["getUser"]>>;
  try {
    const token = await github.exchangeCode({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      code,
      redirectUri: `${publicOrigin(env)}${PORTAL_CALLBACK_PATH}`,
      codeVerifier: saved.v,
    });
    user = await github.getUser(token);
  } catch (error) {
    logError("auth.github_failed", error, { flow: "portal" });
    return withHeaders(
      errorPage(502, "Sign-in failed", "GitHub sign-in failed. Try again."),
      clear,
    );
  }
  const admission = await admit(env, user);
  if (!admission.ok) return withHeaders(refusalPage(admission), clear);

  const session = await signValue(
    env.COOKIE_SECRET,
    "session",
    { uid: admission.userId },
    Date.now() + SESSION_TTL_SECONDS * 1000,
  );
  const next = typeof saved.n === "string" ? safeNext(saved.n) : null;
  const headers = new Headers({ Location: next ?? "/files", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearCookie(PORTAL_STATE_COOKIE));
  headers.append("Set-Cookie", setCookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS));
  return new Response(null, { status: 302, headers });
}

/** Ends the portal session: POST /logout (the portal router checks CSRF first). */
export function logout(): Response {
  return redirect("/", { "Set-Cookie": clearCookie(SESSION_COOKIE) }, 303);
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) response.headers.append(k, v);
  return response;
}
