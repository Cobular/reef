import { addInvite, getFile, listInvites, listUsers, removeInvite, setBanned } from "../files/repo";
import { destroyFile, filesContext } from "../files/service";
import { html } from "../lib/html";
import { logEvent } from "../lib/log";
import { avatar, confirmForm, csrfField, pill, postButton, timeEl } from "./components";
import { type FlashKind, formCsrfOk, readForm, type SignedIn, seeOther } from "./context";
import { forbidden, render } from "./layout";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** GET /admin (the router has already checked the caller is an admin). */
export async function adminPage(p: SignedIn): Promise<Response> {
  const [invites, users] = await Promise.all([listInvites(p.env.DB), listUsers(p.env.DB)]);
  const body = html`<div class="head"><div><h1>Admin</h1>
<p>Invites, accounts and files. Everything here takes effect at once.</p></div></div>
<div class="stack">
<section class="card" aria-labelledby="invites-title">
<h2 id="invites-title">Invites</h2>
<p class="small muted">In invite mode, only these GitHub logins can create an account.</p>
<form method="post" action="/admin/invites/add">${csrfField(p.csrf)}
<label for="invite-login" class="sr-only">GitHub login to invite</label>
<div class="inline-form"><div><input type="text" id="invite-login" name="login" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="GitHub login"></div>
<button type="submit" class="btn">Add invite</button></div>
</form>
${
  invites.length > 0
    ? html`<div class="table-wrap section-gap"><table><thead><tr><th scope="col">Login</th><th scope="col">Added</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${invites.map(
        (i) =>
          html`<tr><td class="mono">${i.login}</td><td>${timeEl(i.created_at, p.now)}</td><td>${
            i.joined ? pill("ready", "Joined") : pill("expired", "Not yet")
          }</td><td>${postButton(
            "/admin/invites/remove",
            p.csrf,
            "Remove",
            "btn small quiet-danger",
            { login: i.login },
          )}</td></tr>`,
      )}</tbody></table></div>`
    : html`<p class="muted section-gap">No invites yet.</p>`
}
</section>
<section class="card" aria-labelledby="users-title">
<h2 id="users-title">Accounts</h2>
<div class="table-wrap"><table><thead><tr><th scope="col">Login</th><th scope="col">Joined</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${users.map(
    (
      u,
    ) => html`<tr><td>${avatar({ id: u.id, login: u.login }, true)} <span class="mono">${u.login}</span></td>
<td>${timeEl(u.created_at, p.now)}</td>
<td>${u.banned ? pill("banned") : pill("ready", "Active")}</td>
<td>${
      u.id === p.user.userId
        ? html`<span class="small muted">you</span>`
        : u.banned
          ? postButton("/admin/users/unban", p.csrf, "Unban", "btn small", { user: String(u.id) })
          : confirmForm({
              action: "/admin/users/ban",
              csrf: p.csrf,
              summary: "Ban",
              explain: `Ban ${u.login}? They’re signed out everywhere and nobody can download their files.`,
              confirm: `Ban ${u.login}`,
              hidden: { user: String(u.id) },
              inline: true,
            })
    }</td></tr>`,
  )}</tbody></table></div>
</section>
<section class="card" aria-labelledby="delete-title">
<h2 id="delete-title">Delete a file</h2>
<p class="small muted">Removes any file at once, for everyone. Use the file ID from a report.</p>
<form method="post" action="/admin/files/delete">${csrfField(p.csrf)}
<div class="field">
<label for="file-id">File ID</label>
<input type="text" id="file-id" name="id" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" required>
</div>
<details class="confirm inline">
<summary class="btn small quiet-danger">Delete this file</summary>
<div class="confirm-panel">
<p>Nobody can download it after this, and it can’t be undone.</p>
<button type="submit" class="btn small danger">Delete for everyone</button>
</div>
</details>
</form>
</section>
</div>`;
  return render(p, { title: "Admin", section: "admin" }, body);
}

export type AdminAction =
  | "invites/add"
  | "invites/remove"
  | "users/ban"
  | "users/unban"
  | "files/delete";

export const ADMIN_ACTIONS: readonly AdminAction[] = [
  "invites/add",
  "invites/remove",
  "users/ban",
  "users/unban",
  "files/delete",
];

/** POST /admin/<action> */
export async function adminAction(p: SignedIn, action: AdminAction): Promise<Response> {
  const form = await readForm(p.request);
  if (!form || !formCsrfOk(p, form)) return forbidden(p);
  const db = p.env.DB;
  const done = (message: string, kind: FlashKind = "ok") => seeOther(p, "/admin", message, kind);

  switch (action) {
    case "invites/add":
    case "invites/remove": {
      const login = (form.get("login") ?? "").trim().replace(/^@/, "");
      if (!LOGIN.test(login))
        return done(
          "Enter a GitHub login: letters, digits and hyphens, up to 39 characters.",
          "error",
        );
      if (action === "invites/add") {
        const added = await addInvite(db, login, p.now);
        logEvent("admin.invite_added", { user: p.user.userId, added });
        return added ? done(`Invited ${login}.`) : done(`${login} was already invited.`, "info");
      }
      const removed = await removeInvite(db, login);
      logEvent("admin.invite_removed", { user: p.user.userId, removed });
      return removed
        ? done(`Removed the invite for ${login}.`)
        : done(`${login} had no invite.`, "info");
    }
    case "users/ban":
    case "users/unban": {
      const id = Number(form.get("user"));
      if (!Number.isSafeInteger(id) || id <= 0)
        return done("Choose an account from the list.", "error");
      const ban = action === "users/ban";
      if (ban && id === p.user.userId) return done("You can’t ban your own account.", "error");
      const user = await setBanned(db, id, ban, p.now);
      if (!user) return done("There is no account with that ID.", "error");
      logEvent(ban ? "admin.banned" : "admin.unbanned", { user: p.user.userId, target: id });
      return done(
        ban
          ? `Banned ${user.login}. They’re signed out and nobody can download their files.`
          : `Unbanned ${user.login}. They can sign in again.`,
      );
    }
    case "files/delete": {
      const id = (form.get("id") ?? "").trim();
      const file = /^[a-z0-9]{1,64}$/.test(id) ? await getFile(db, id) : null;
      if (!file || file.state === "deleted")
        return done(
          `No live file has the ID ${id || "you entered"}. Check the ID and try again.`,
          "error",
        );
      await destroyFile(filesContext(p.env, p.partSize, p.now), file);
      logEvent("admin.file_deleted", { user: p.user.userId, file: file.id });
      return done(`Deleted ${file.name} (${file.id}) for everyone.`);
    }
  }
}
