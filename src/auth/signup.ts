import { DAY_MS, MAX_NEW_ACCOUNTS_PER_DAY, signupMode, utcDay } from "../config";
import { getUser, insertUser, insertUserCapped, isInvited, updateUserLogin } from "../files/repo";
import { html, page } from "../lib/html";
import { logEvent } from "../lib/log";
import type { GitHubUser } from "./github";

export type Admission =
  | { ok: true; userId: number; login: string; created: boolean }
  | { ok: false; reason: "banned" | "not_invited"; login: string }
  /** The day's new-account cap is reached; `retryAt` is the next 00:00 UTC. */
  | { ok: false; reason: "full"; login: string; retryAt: number };

/**
 * Decides whether a GitHub user may sign in, and creates or refreshes their account.
 * - A banned account is refused everywhere.
 * - An existing account signs in (its login is refreshed, since GitHub logins can change).
 * - A new account needs its login in `invites` (case-insensitive), or SIGNUP_MODE=open. In open
 *   mode, uninvited logins get one of MAX_NEW_ACCOUNTS_PER_DAY places per UTC day.
 */
export async function admit(env: Env, gh: GitHubUser, now = Date.now()): Promise<Admission> {
  const db = env.DB;
  const existing = await getUser(db, gh.id);
  if (existing) {
    if (existing.banned) {
      logEvent("auth.refused", { user: gh.id, reason: "banned" });
      return { ok: false, reason: "banned", login: gh.login };
    }
    if (existing.login !== gh.login) await updateUserLogin(db, gh.id, gh.login);
    return { ok: true, userId: gh.id, login: gh.login, created: false };
  }
  const invited = await isInvited(db, gh.login);
  if (!invited && signupMode(env) !== "open") {
    logEvent("auth.refused", { user: gh.id, reason: "not_invited" });
    return { ok: false, reason: "not_invited", login: gh.login };
  }
  if (invited) {
    await insertUser(db, gh.id, gh.login, now);
  } else {
    const dayStart = utcDay(now) * DAY_MS;
    const inserted = await insertUserCapped(
      db,
      gh.id,
      gh.login,
      now,
      dayStart,
      MAX_NEW_ACCOUNTS_PER_DAY,
    );
    if (!inserted) {
      logEvent("auth.refused", { user: gh.id, reason: "full" });
      return { ok: false, reason: "full", login: gh.login, retryAt: dayStart + DAY_MS };
    }
  }
  logEvent("auth.signup", { user: gh.id, invited });
  return { ok: true, userId: gh.id, login: gh.login, created: true };
}

export function refusalPage(
  refusal: Extract<Admission, { ok: false }>,
  now = Date.now(),
): Response {
  if (refusal.reason === "banned") {
    return page(
      "Account suspended",
      html`<p>The Reef account for GitHub user <strong>${refusal.login}</strong> is suspended.</p>`,
      { status: 403 },
    );
  }
  if (refusal.reason === "full") {
    const at = new Date(refusal.retryAt).toISOString().slice(0, 10);
    return page(
      "Reef is full for today",
      html`<p>Reef has let in as many new accounts as it can today, so no account was created for
        GitHub user <strong>${refusal.login}</strong>.</p>
        <p>Try again after 00:00 UTC on ${at}. Or, if you already know someone on Reef, ask them to
        get you an invite from the operator: invited accounts don’t count toward the daily
        limit.</p>`,
      {
        status: 503,
        headers: { "Retry-After": String(Math.max(1, Math.ceil((refusal.retryAt - now) / 1000))) },
      },
    );
  }
  return page(
    "Reef is invite-only",
    html`<p>GitHub user <strong>${refusal.login}</strong> is not on the Reef invite list, so no
      account was created.</p>
      <p>Ask the operator for an invite, then sign in again.</p>`,
    { status: 403 },
  );
}
