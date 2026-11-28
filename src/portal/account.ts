import { changeDisplayName, deleteAccount, type GrantRevoker } from "../account/service";
import { SESSION_COOKIE, signupMode } from "../config";
import { getUser } from "../files/repo";
import { html } from "../lib/html";
import { clearCookie } from "../lib/http";
import { csrfField, fieldError, timeEl, utcText } from "./components";
import { formCsrfOk, readForm, type SignedIn, seeOther } from "./context";
import { forbidden, render } from "./layout";

interface NameState {
  value: string;
  error: string;
}

/** GET /account, and the re-render when a form on it is refused. */
export async function accountPage(
  p: SignedIn,
  error: string | null = null,
  status = 200,
  nameState: NameState | null = null,
) {
  const user = await getUser(p.env.DB, p.user.userId);
  const created = user
    ? html`${timeEl(user.created_at, p.now)} <span class="muted small">(${utcText(user.created_at)})</span>`
    : "";
  const reinvite =
    signupMode(p.env) === "open"
      ? ""
      : " Reef is invite-only right now, so you’d need a new invite.";
  const body = html`<div class="head"><div><h1>Your account</h1>
<p>Your Reef account is your GitHub account; Reef keeps only the login and numeric ID, and the display name if you choose one.</p></div></div>
<div class="narrow stack">
<section class="card" aria-labelledby="account-title">
<h2 id="account-title">Account</h2>
<dl class="kv">
<dt>GitHub login</dt><dd class="mono">${p.user.login}</dd>
<dt>Created</dt><dd>${created}</dd>
</dl>
</section>
<section class="card" aria-labelledby="name-title">
<h2 id="name-title">Display name</h2>
<p>Reef shows this name instead of your GitHub login to other members and their agent sessions: in school messages and member lists, on share lists, and in the portal, where your GitHub picture is hidden too. People can still invite you or share files with you by either name.</p>
<form method="post" action="/account/name">${csrfField(p.csrf)}
<div class="field">
<label for="display-name">Display name</label>
<input type="text" id="display-name" name="name" maxlength="39" autocomplete="off" autocapitalize="off" spellcheck="false" value="${
    nameState?.value ?? user?.display_name ?? ""
  }" aria-describedby="display-name-hint display-name-error"${
    nameState ? html` aria-invalid="true"` : ""
  }>
<p class="hint" id="display-name-hint">Letters, digits, hyphens, underscores and dots, up to 39. Leave it empty to show your GitHub login.</p>
${fieldError("display-name-error", nameState?.error ?? null)}
</div>
<button type="submit" class="btn">Save display name</button>
</form>
</section>
<section class="card" aria-labelledby="delete-title">
<h2 id="delete-title">Delete your account</h2>
<p>Deleting your account removes, straight away:</p>
<ul>
<li>your files, including any upload still in progress, and your access to files others shared with you;</li>
<li>every message you sent, in every school;</li>
<li>your school memberships and invitations (a school where you’re the only member is deleted too);</li>
<li>your agent sessions, and the access you gave apps to use Reef for you.</li>
</ul>
<p>It can’t be undone. If you sign in again later, you’ll get a fresh, empty account.${reinvite}</p>
<form method="post" action="/account/delete">${csrfField(p.csrf)}
<div class="field">
<label for="confirm-login">To confirm, type your GitHub login, <span class="mono">${p.user.login}</span></label>
<input type="text" id="confirm-login" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false" required aria-describedby="confirm-error"${
    error ? html` aria-invalid="true"` : ""
  }>
${fieldError("confirm-error", error)}
</div>
<button type="submit" class="btn danger">Delete my account</button>
</form>
</section>
</div>`;
  return render(p, { title: "Your account", section: "account", status }, body);
}

/** POST /account/name: sets or clears the display name. */
export async function displayNameFromPortal(p: SignedIn): Promise<Response> {
  const form = await readForm(p.request);
  if (!form || !formCsrfOk(p, form)) return forbidden(p);
  const value = String(form.get("name") ?? "");
  const result = await changeDisplayName(p.env.DB, p.user.userId, value);
  if (!result.ok) return accountPage(p, null, 400, { value, error: result.error });
  return seeOther(
    p,
    "/account",
    result.name === null
      ? "Display name cleared. Reef shows your GitHub login again."
      : `Saved. Reef now shows you as ${result.name}.`,
  );
}

/**
 * POST /account/delete: needs the form token and the login typed out (any case). Deletes the
 * account, signs this browser out and shows a plain confirmation. Other browsers' sessions end on
 * their next request, since the account is gone.
 */
export async function deleteAccountFromPortal(p: SignedIn, oauth: GrantRevoker): Promise<Response> {
  const form = await readForm(p.request);
  if (!form || !formCsrfOk(p, form)) return forbidden(p);
  const typed = (form.get("confirm") ?? "").trim();
  if (typed.toLowerCase() !== p.user.login.toLowerCase())
    return accountPage(
      p,
      typed === ""
        ? "Type your GitHub login to confirm."
        : "That isn’t your GitHub login. Type it exactly as shown, then try again.",
      400,
    );
  const deleted = await deleteAccount(p.env, oauth, p.user.userId);
  const signedOut = { ...p, user: null, csrf: null, admin: false, flash: null };
  return render(
    signedOut,
    { title: "Account deleted", headers: { "Set-Cookie": clearCookie(SESSION_COOKIE) } },
    html`<div class="card narrow">
<h1>Your account is deleted</h1>
<p>Reef deleted the account for <span class="mono">${p.user.login}</span>${
      deleted
        ? html`, with its ${filesText(deleted.files)} and ${messagesText(deleted.messages)}`
        : ""
    }, and signed you out.</p>
<p class="muted">Thanks for trying Reef.</p>
<a class="btn" href="/">Go to the Reef home page</a>
</div>`,
  );
}

function filesText(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

function messagesText(n: number): string {
  return n === 1 ? "1 message" : `${n} messages`;
}
