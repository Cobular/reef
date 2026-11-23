import { deleteAccount, type GrantRevoker } from "../account/service";
import { SESSION_COOKIE, signupMode } from "../config";
import { getUser } from "../files/repo";
import { html } from "../lib/html";
import { clearCookie } from "../lib/http";
import { csrfField, fieldError, timeEl, utcText } from "./components";
import { formCsrfOk, readForm, type SignedIn } from "./context";
import { forbidden, render } from "./layout";

/** GET /account, and the re-render when the typed login doesn't match. */
export async function accountPage(p: SignedIn, error: string | null = null, status = 200) {
  const user = await getUser(p.env.DB, p.user.userId);
  const created = user
    ? html`${timeEl(user.created_at, p.now)} <span class="muted small">(${utcText(user.created_at)})</span>`
    : "";
  const reinvite =
    signupMode(p.env) === "open"
      ? ""
      : " Reef is invite-only right now, so you’d need a new invite.";
  const body = html`<div class="head"><div><h1>Your account</h1>
<p>Your Reef account is your GitHub account; Reef keeps only the login and numeric ID.</p></div></div>
<div class="narrow stack">
<section class="card" aria-labelledby="account-title">
<h2 id="account-title">Account</h2>
<dl class="kv">
<dt>GitHub login</dt><dd class="mono">${p.user.login}</dd>
<dt>Created</dt><dd>${created}</dd>
</dl>
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
