import { publicOrigin } from "../config";
import type { ListedFileView } from "../files/service";
import { filesContext, listFiles } from "../files/service";
import { html, type Raw } from "../lib/html";
import {
  confirmForm,
  connectPanel,
  emptyState,
  formatSize,
  looksLikeFileName,
  pill,
  sharedWith,
  tide,
  timeEl,
} from "./components";
import type { SignedIn } from "./context";
import { render } from "./layout";

export function fileName(name: string): Raw {
  return looksLikeFileName(name) ? html`<span class="mono">${name}</span>` : html`${name}`;
}

export function ownerText(view: ListedFileView, userId: number): string {
  return view.file.owner_id === userId ? "you" : view.file.owner_login;
}

export function downloadsText(view: ListedFileView): string {
  if (view.downloadsLeft === null) return "No download limit";
  if (view.downloadsLeft === 0) return "No downloads left";
  return view.downloadsLeft === 1 ? "1 download left" : `${view.downloadsLeft} downloads left`;
}

const uploadLink = html`<a class="btn primary" href="/files/new">Upload a file</a>`;

function fileRow(p: SignedIn, view: ListedFileView): Raw {
  const { file } = view;
  const href = `/files/${file.id}`;
  const mine = file.owner_id === p.user.userId;
  let timer: Raw;
  if (view.status === "ready" && file.expires_at !== null)
    timer = tide(file.expires_at, file.lifetime_minutes, p.now);
  else if (view.status === "uploading")
    timer = html`<span class="small muted">The clock starts when the upload finishes.</span>`;
  else
    timer = html`<span class="small muted">${
      file.expires_at !== null ? html`Gone ${timeEl(file.expires_at, p.now)}` : "Gone"
    }</span>`;
  const status =
    view.status === "ready" ? pill("ready") : view.status === "uploading" ? pill("uploading") : "";
  return html`<li class="row file${view.status === "gone" ? " gone" : ""}">
<div>
<div class="row-title"><a href="${href}">${fileName(file.name)}</a>${status}</div>
<div class="meta"><span>${formatSize(file.size)}</span><span>${
    mine ? "Yours" : html`From ${file.owner_login}`
  }</span>${
    view.shareAccounts.length > 0
      ? html`<span class="shared">Shared with ${sharedWith(view.shareAccounts, p.user.userId, 2)}</span>`
      : html`<span>Not shared</span>`
  }${view.status === "gone" ? "" : html`<span>${downloadsText(view)}</span>`}</div>
</div>
<div>${timer}</div>
<div class="row-actions">${
    view.status === "gone"
      ? ""
      : html`${
          view.status === "ready"
            ? html`<a class="btn small" href="${href}" aria-label="Download ${file.name}">Download</a>`
            : ""
        }${confirmForm({
          action: `${href}/delete`,
          csrf: p.csrf,
          summary: "Delete",
          explain: `Delete ${file.name} now? Nobody on the share list can fetch it after this.`,
          confirm: "Delete for everyone",
          hidden: { back: "/files" },
        })}`
  }</div>
</li>`;
}

/** GET /files: the caller's files and files shared with them. */
export async function filesPage(p: SignedIn): Promise<Response> {
  const views = await listFiles(filesContext(p.env, p.partSize, p.now), p.user);
  const live = views.filter((v) => v.status !== "gone");
  const gone = views.filter((v) => v.status === "gone");
  const body = html`<div class="head">
<div><h1>Files</h1><p>Your files and files shared with you. Each one expires minutes after it lands.</p></div>
${live.length > 0 ? uploadLink : ""}
</div>
${
  live.length > 0
    ? html`<ul class="rows" aria-label="Live files">${live.map((v) => fileRow(p, v))}</ul>`
    : emptyState(
        "Nothing in the water right now.",
        html`Upload a file here, or ask an agent to send one with Reef’s <code>create_upload</code> tool.`,
        uploadLink,
      )
}
${
  gone.length > 0
    ? html`<details class="past section-gap"><summary>Recently expired (${String(gone.length)})</summary>
<ul class="rows" aria-label="Recently expired files">${gone.map((v) => fileRow(p, v))}</ul>
</details>`
    : ""
}
${connectPanel(`${publicOrigin(p.env)}/mcp`)}`;
  return render(p, { title: "Files", section: "files" }, body);
}
