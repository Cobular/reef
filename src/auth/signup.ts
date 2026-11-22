import { signupMode } from "../config";
import { getUser, insertUser, isInvited, updateUserLogin } from "../files/repo";
import { html, page } from "../lib/html";
import { logEvent } from "../lib/log";
import type { GitHubUser } from "./github";

export type Admission =
  | { ok: true; userId: number; login: string; created: boolean }
  | { ok: false; reason: "banned" | "not_invited"; login: string };

/**
 * Decides whether a GitHub user may sign in, and creates or refreshes their account.
 * - A banned account is refused everywhere.
 * - An existing account signs in (its login is refreshed, since GitHub logins can change).
 * - A new account needs SIGNUP_MODE=open, or its login in `invites` (case-insensitive).
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
  if (signupMode(env) !== "open" && !(await isInvited(db, gh.login))) {
    logEvent("auth.refused", { user: gh.id, reason: "not_invited" });
    return { ok: false, reason: "not_invited", login: gh.login };
  }
  await insertUser(db, gh.id, gh.login, now);
  logEvent("auth.signup", { user: gh.id });
  return { ok: true, userId: gh.id, login: gh.login, created: true };
}

export function refusalPage(refusal: Extract<Admission, { ok: false }>): Response {
  if (refusal.reason === "banned") {
    return page(
      "Account suspended",
      html`<p>The Reef account for GitHub user <strong>${refusal.login}</strong> is suspended.</p>`,
      { status: 403 },
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
