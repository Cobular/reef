import { LIMITS } from "../config";
import { fileNameProblem } from "../files/commands";
import { createUpload, filesContext, ReefError } from "../files/service";
import { html } from "../lib/html";
import { logError } from "../lib/log";
import { copyBlock, csrfField, fieldError, icons } from "./components";
import { formCsrfOk, loginList, readForm, type SignedIn } from "./context";
import { render } from "./layout";

export const LIFETIMES = [5, 10, 15, 30] as const;

/** GET /files/new: the browser upload form, and the result card the script reveals. */
export function uploadPage(p: SignedIn): Response {
  const body = html`<div class="head"><div><h1>Upload a file</h1>
<p>Reef encrypts it with a fresh key and keeps it for the time you choose.</p></div></div>
<noscript><p class="note narrow">Browser upload needs JavaScript, because the page has to read and send the file in pieces. Agents can upload without a browser, using Reef’s <code>create_upload</code> tool.</p></noscript>
<form id="upload" class="card narrow" method="post" action="/files/new" novalidate>
${csrfField(p.csrf)}
<p id="form-error" class="field-error" role="alert" tabindex="-1" hidden></p>
<div class="field">
<label for="file">File</label>
<div id="drop" class="drop">${icons.upload}
<p>Drop a file here, or choose one.</p>
<input type="file" id="file" name="file" aria-describedby="file-hint file-error">
<p id="chosen" class="chosen" hidden></p>
</div>
<p class="hint" id="file-hint">Up to 10 GB.</p>
${fieldError("file-error", null)}
</div>
<fieldset class="field" aria-describedby="lifetime-hint lifetime-error">
<legend>Lifetime</legend>
<div class="seg">${LIFETIMES.map(
    (m) =>
      html`<input type="radio" name="lifetime" id="lifetime-${String(m)}" value="${String(m)}"${
        m === LIMITS.defaultLifetimeMinutes ? html` checked` : ""
      }><label for="lifetime-${String(m)}">${String(m)} min</label>`,
  )}</div>
<p class="hint" id="lifetime-hint">The clock starts when the upload finishes.</p>
${fieldError("lifetime-error", null)}
</fieldset>
<div class="field">
<label for="share_with">Share with <span class="opt">(optional)</span></label>
<input type="text" id="share_with" name="share_with" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="share-hint share_with-error">
<p class="hint" id="share-hint">GitHub logins, separated by spaces or commas. Each person must have signed in to Reef once. You can always download your own files.</p>
${fieldError("share_with-error", null)}
</div>
<div class="field">
<label for="download_limit">Download limit <span class="opt">(optional)</span></label>
<input type="number" class="short" id="download_limit" name="download_limit" min="1" step="1" inputmode="numeric" aria-describedby="limit-hint download_limit-error">
<p class="hint" id="limit-hint">Leave empty for no limit.</p>
${fieldError("download_limit-error", null)}
</div>
<button type="submit" id="upload-go" class="btn primary" disabled>Upload</button>
<div id="progress" hidden>
<div class="bar" role="presentation"><span></span></div>
<div class="progress-row"><span id="progress-text" class="small muted"></span>
<button type="button" id="cancel" class="btn small quiet">Cancel upload</button></div>
<p id="progress-live" class="sr-only" aria-live="polite"></p>
</div>
</form>
<section id="result" class="card narrow" aria-labelledby="result-title" hidden>
<h2 id="result-title" tabindex="-1">Uploaded <span class="mono" data-slot="name"></span></h2>
<p class="muted">Send this handoff line to the person or agent session that needs the file.</p>
${copyBlock("handoff", "", "Copy the handoff line", { large: true, guard: true })}
<p class="small muted">Or just the key:</p>
${copyBlock("key", "", "Copy the key", { guard: true })}
<p class="note">This is the only time Reef shows the key. Anyone on the share list who has this line can download the file until it expires.</p>
<dl class="kv">
<dt>Expires</dt>
<dd><time datetime="" title="" data-clock></time>
<div class="timer" data-end="0" data-total="1"><div class="tide" role="presentation"><span class="w100"></span></div><span class="left"></span></div></dd>
</dl>
<p class="section-gap"><a class="btn" data-slot="link" href="/files">View the file</a> <a class="btn quiet" href="/files/new">Upload another</a></p>
</section>`;
  return render(p, { title: "Upload a file", section: "files" }, body);
}

type Field = "file" | "lifetime" | "share_with" | "download_limit" | "form";

function fieldFail(status: number, field: Field, message: string): Response {
  return Response.json(
    { error: { field, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Which input a service refusal belongs next to, in the words the form uses. */
function placeError(error: ReefError): { field: Field; message: string } {
  const m = error.message;
  if (m.startsWith("Not Reef accounts") || m.startsWith("A share list"))
    return { field: "share_with", message: m };
  if (m.startsWith("download_limit"))
    return {
      field: "download_limit",
      message: "Enter a whole number of downloads, 1 or more, or leave it empty for no limit.",
    };
  if (m.startsWith("lifetime_minutes"))
    return { field: "lifetime", message: "Choose 5, 10, 15 or 30 minutes." };
  if (m.startsWith("name ")) return { field: "file", message: nameMessage(m) };
  if (m.startsWith("File too large") || m.startsWith("Account storage") || m.startsWith("size"))
    return { field: "file", message: m };
  return { field: "form", message: m };
}

function nameMessage(problem: string): string {
  return `Reef can’t use this file’s name (${problem}). Rename the file and try again.`;
}

/**
 * POST /files/new (JSON): starts a browser upload. The script then sends the bytes to /up with
 * the token and key, exactly as an agent would.
 */
export async function createBrowserUpload(p: SignedIn): Promise<Response> {
  const form = await readForm(p.request);
  if (!formCsrfOk(p, form) || !form)
    return fieldFail(
      403,
      "form",
      "Reef could not confirm this upload came from your own Reef page. Reload the page and try again.",
    );
  const name = form.get("name") ?? "";
  if (name === "") return fieldFail(400, "file", "Choose a file to upload.");
  const nameProblem = fileNameProblem(name);
  if (nameProblem) return fieldFail(400, "file", nameMessage(nameProblem));
  const sizeText = form.get("size") ?? "";
  if (!/^\d{1,16}$/.test(sizeText))
    return fieldFail(400, "file", "Reef could not read the file’s size. Choose it again.");
  const lifetime = Number(form.get("lifetime") ?? LIMITS.defaultLifetimeMinutes);
  if (!(LIFETIMES as readonly number[]).includes(lifetime))
    return fieldFail(400, "lifetime", "Choose 5, 10, 15 or 30 minutes.");
  const limitText = (form.get("download_limit") ?? "").trim();
  if (limitText !== "" && !/^[1-9]\d{0,8}$/.test(limitText))
    return fieldFail(
      400,
      "download_limit",
      "Enter a whole number of downloads, 1 or more, or leave it empty for no limit.",
    );
  try {
    const created = await createUpload(filesContext(p.env, p.partSize, p.now), p.user, {
      name,
      size: Number(sizeText),
      lifetime_minutes: lifetime,
      download_limit: limitText === "" ? undefined : Number(limitText),
      share_with: loginList(form.get("share_with")),
    });
    return Response.json(
      {
        fileId: created.file.id,
        name: created.file.name,
        token: created.token,
        key: created.key,
        partSize: p.partSize,
        parts: created.parts,
        lifetimeMinutes: created.file.lifetime_minutes,
        handoff: created.handoff,
        shareWith: created.shareWith,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ReefError) {
      const { field, message } = placeError(error);
      return fieldFail(error.status, field, message);
    }
    logError("portal.upload_create_failed", error);
    return fieldFail(500, "form", "Reef could not start the upload. Try again in a moment.");
  }
}
