import { streamDownload } from "../files/http";
import { parseKey } from "../files/key";
import {
  deleteFile,
  downloadableFile,
  fileDetails,
  filesContext,
  type ListedFileView,
  ReefError,
  shareFile,
} from "../files/service";
import { WrongKeyError } from "../files/storage";
import { html, type Raw } from "../lib/html";
import { safeNext } from "../lib/http";
import {
  avatar,
  clockEl,
  confirmForm,
  csrfField,
  fieldError,
  formatSize,
  icons,
  pill,
  sharedWith,
  tide,
  timeEl,
  utcText,
} from "./components";
import { formCsrfOk, loginList, readForm, type SignedIn, seeOther } from "./context";
import { downloadsText, fileName, ownerText } from "./files";
import { forbidden, render } from "./layout";

interface DetailErrors {
  key?: string;
  share?: string;
  status?: number;
}

/** Expired, deleted, missing or not shared: one message, so no one learns which. */
function swumOff(p: SignedIn, goneAt: number | null): Response {
  return render(
    p,
    { title: "This file has swum off", section: "files", status: goneAt === null ? 404 : 410 },
    html`<div class="card narrow empty">${icons.waves}
<h1 class="lead">This file has swum off.</h1>
<p class="muted">${
      goneAt === null
        ? "It may have expired or been deleted, or it was never shared with you. Ask the sender to upload it again and share it with you."
        : html`It went ${timeEl(goneAt, p.now)} (${utcText(goneAt)}). Ask the sender to upload it again if you still need it.`
    }</p>
<a class="btn" href="/files">Back to your files</a>
</div>`,
  );
}

function shareEditor(p: SignedIn, view: ListedFileView, error: string | undefined): Raw {
  const href = `/files/${view.file.id}/share`;
  return html`<section class="card" aria-labelledby="share-title">
<h2 id="share-title">Share list</h2>
${
  view.shareAccounts.length > 0
    ? html`<ul class="people">${view.shareAccounts.map(
        (a) => html`<li>${avatar(a, true)}<span class="mono">${a.login}</span>
<form method="post" action="${href}">${csrfField(p.csrf)}<input type="hidden" name="remove" value="${a.login}">
<button type="submit" class="btn small quiet" aria-label="Remove ${a.login} from the share list">Remove</button></form></li>`,
      )}</ul>`
    : html`<p class="muted small">Only you can download this file.</p>`
}
<form method="post" action="${href}" class="section-gap">${csrfField(p.csrf)}
<label for="add">Add people</label>
<div class="inline-form"><div><input type="text" id="add" name="add" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="add-hint add-error"${
    error ? html` aria-invalid="true"` : ""
  }>
<p class="hint" id="add-hint">GitHub logins, separated by spaces or commas.</p>
${fieldError("add-error", error ?? null)}</div>
<button type="submit" class="btn">Add</button></div>
</form>
</section>`;
}

function detailPage(p: SignedIn, view: ListedFileView, errors: DetailErrors = {}): Response {
  const { file } = view;
  const owner = file.owner_id === p.user.userId;
  const base = `/files/${file.id}`;
  const usedUp = view.downloadsLeft === 0;
  let download: Raw;
  if (view.status === "uploading")
    download = html`<p class="muted">This upload hasn’t finished yet. Downloads open as soon as it does.</p>`;
  else if (usedUp)
    download = html`<p class="muted">This file’s download limit is used up, so nobody can download it again.</p>`;
  else
    download = html`<form method="post" action="${base}/download">${csrfField(p.csrf)}
<div class="field">
<label for="key">Key or handoff line</label>
<input type="text" id="key" name="key" autocomplete="off" autocapitalize="off" spellcheck="false" class="mono" aria-describedby="key-hint key-error"${
      errors.key ? html` aria-invalid="true"` : ""
    }>
<p class="hint" id="key-hint">Paste the whole <span class="mono">Reef handoff:</span> line you were sent, or just its key.</p>
${fieldError("key-error", errors.key ?? null)}
</div>
<button type="submit" class="btn primary">Download</button>
</form>`;

  const body = html`<p class="small"><a href="/files">← Files</a></p>
<div class="title-row"><h1>${fileName(file.name)}</h1>${
    view.status === "ready" ? pill("ready") : pill("uploading")
  }</div>
<div class="split">
<div class="stack">
<section class="card" aria-labelledby="dl-title"><h2 id="dl-title" class="sr-only">Download</h2>${download}</section>
<section class="card" aria-labelledby="about-title"><h2 id="about-title" class="sr-only">Details</h2>
<dl class="kv">
<dt>Size</dt><dd>${formatSize(file.size)}</dd>
<dt>From</dt><dd>${ownerText(view, p.user.userId)}</dd>
<dt>Shared with</dt><dd>${view.shareAccounts.length > 0 ? sharedWith(view.shareAccounts, p.user.userId) : "Nobody else"}</dd>
<dt>Expires</dt><dd>${
    file.expires_at !== null
      ? html`${clockEl(file.expires_at)}${tide(file.expires_at, file.lifetime_minutes, p.now)}`
      : html`${String(file.lifetime_minutes)} min after the upload finishes`
  }</dd>
<dt>Downloads</dt><dd>${downloadsText(view)}</dd>
<dt>File ID</dt><dd class="mono">${file.id}</dd>
</dl>
</section>
</div>
<aside class="panel" aria-label="Manage this file">
${owner ? shareEditor(p, view, errors.share) : ""}
<section class="card" aria-labelledby="delete-title"><h2 id="delete-title">Delete</h2>
<p class="small muted">${owner ? "Remove the file now, before it expires." : "Anyone on the share list can remove the file early."}</p>
${confirmForm({
  action: `${base}/delete`,
  csrf: p.csrf,
  summary: "Delete this file",
  explain: "Nobody can download it after this, and it can’t be undone.",
  confirm: "Delete for everyone",
  inline: true,
})}
</section>
</aside>
</div>`;
  return render(p, { title: file.name, section: "files", status: errors.status ?? 200 }, body);
}

async function loadView(p: SignedIn, id: string): Promise<ListedFileView | null> {
  try {
    return await fileDetails(filesContext(p.env, p.partSize, p.now), p.user, id);
  } catch (error) {
    if (error instanceof ReefError && error.status === 404) return null;
    throw error;
  }
}

/** GET /files/:id */
export async function filePage(p: SignedIn, id: string): Promise<Response> {
  const view = await loadView(p, id);
  if (!view) return swumOff(p, null);
  if (view.status === "gone") return swumOff(p, view.file.expires_at ?? view.file.created_at);
  return detailPage(p, view);
}

/** Pulls the key out of a bare key or a whole "Reef handoff: id=… key=…" line. */
export function keyFromInput(value: string, fileId: string): { key: string } | { error: string } {
  const text = value.trim();
  if (text === "") return { error: "Paste the handoff line or the key, then download." };
  if (/\bkey=/.test(text)) {
    const id = /\bid=(\S+)/.exec(text)?.[1];
    if (id && id !== fileId)
      return {
        error:
          "That handoff line is for a different file. Open the file it names, or paste this file’s line.",
      };
    const key = /\bkey=(\S+)/.exec(text)?.[1] ?? "";
    return { key };
  }
  return { key: text };
}

/** POST /files/:id/download: checks the session and access, then streams with the key. */
export async function downloadFromPortal(p: SignedIn, id: string): Promise<Response> {
  const form = await readForm(p.request);
  if (!form || !formCsrfOk(p, form)) return forbidden(p);
  const ctx = filesContext(p.env, p.partSize, p.now);
  const view = await loadView(p, id);
  if (!view) return swumOff(p, null);
  if (view.status === "gone") return swumOff(p, view.file.expires_at ?? view.file.created_at);

  const parsed = keyFromInput(form.get("key") ?? "", view.file.id);
  if ("error" in parsed) return detailPage(p, view, { key: parsed.error, status: 400 });
  const key = parseKey(parsed.key);
  if (!key)
    return detailPage(p, view, {
      key: "That isn’t a Reef key. Paste the whole handoff line, or the 44-character key from it.",
      status: 400,
    });
  try {
    const file = await downloadableFile(ctx, p.user, id);
    return await streamDownload(ctx, file, p.user.userId, key, null);
  } catch (error) {
    if (error instanceof WrongKeyError)
      return detailPage(p, view, {
        key: "That key doesn’t match this file. Check you copied the whole line.",
        status: 403,
      });
    if (error instanceof ReefError) {
      if (error.status === 404) return swumOff(p, null);
      const fresh = await loadView(p, id);
      if (!fresh) return swumOff(p, null);
      if (fresh.status === "gone")
        return swumOff(p, fresh.file.expires_at ?? fresh.file.created_at);
      return detailPage(p, fresh, { key: error.message, status: error.status });
    }
    throw error;
  }
}

/** POST /files/:id/share (owner only; the service enforces it). */
export async function shareFromPortal(p: SignedIn, id: string): Promise<Response> {
  const form = await readForm(p.request);
  if (!form || !formCsrfOk(p, form)) return forbidden(p);
  const add = loginList(form.get("add"));
  const remove = loginList(form.get("remove"));
  if (add.length === 0 && remove.length === 0) {
    const view = await loadView(p, id);
    if (!view || view.status === "gone") return swumOff(p, view?.file.expires_at ?? null);
    return detailPage(p, view, { share: "Type at least one GitHub login to add.", status: 400 });
  }
  try {
    await shareFile(filesContext(p.env, p.partSize, p.now), p.user, id, add, remove);
  } catch (error) {
    if (!(error instanceof ReefError)) throw error;
    const view = await loadView(p, id);
    if (!view || view.status === "gone") return swumOff(p, view?.file.expires_at ?? null);
    return detailPage(p, view, { share: error.message, status: error.status });
  }
  const message =
    add.length > 0
      ? `Shared with ${add.join(", ")}.`
      : `Removed ${remove.join(", ")} from the share list.`;
  return seeOther(p, `/files/${id}`, message);
}

/** POST /files/:id/delete, for the owner or anyone on the share list. */
export async function deleteFromPortal(p: SignedIn, id: string): Promise<Response> {
  const form = await readForm(p.request);
  if (!form || !formCsrfOk(p, form)) return forbidden(p);
  const back = safeNext(form.get("back")) ?? "/files";
  try {
    const file = await deleteFile(filesContext(p.env, p.partSize, p.now), p.user, id);
    return seeOther(p, back, `Deleted ${file.name} for everyone.`);
  } catch (error) {
    if (!(error instanceof ReefError)) throw error;
    if (error.status === 404) return swumOff(p, null);
    return seeOther(p, back, "That file was already gone.", "info");
  }
}
