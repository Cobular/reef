import type { SessionType } from "../config";
import { html, type Raw, raw } from "../lib/html";
import type { Flash } from "./context";

// ---- formatting ------------------------------------------------------------------------------

/** "3.2 MB": base 1024, the way file managers show it. */
export function formatSize(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  if (i === 0) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** "2026-05-05 14:03:00 UTC" */
export function utcText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** "just now", "8 min ago", "in 3 h", "yesterday", "4 days ago"; the same rules as the script. */
export function relativeText(ms: number, now: number): string {
  const d = ms - now;
  const a = Math.abs(d);
  if (a < 45_000) return "just now";
  const m = Math.round(a / 60_000);
  const h = Math.round(a / 3_600_000);
  let t: string;
  if (m < 60) t = `${m} min`;
  else if (h < 24) t = `${h} h`;
  else if (h < 48) return d < 0 ? "yesterday" : "tomorrow";
  else t = `${Math.round(a / 86_400_000)} days`;
  return d < 0 ? `${t} ago` : `in ${t}`;
}

/** "8 min left", "1 min left", "40 s left", "Expired". */
export function timeLeftText(msLeft: number): string {
  const s = Math.ceil(msLeft / 1000);
  if (s <= 0) return "Expired";
  if (s < 60) return `${s} s left`;
  if (s < 120) return "1 min left";
  return `${Math.ceil(s / 60)} min left`;
}

/** File names with an extension (or no spaces) read better in mono. */
export function looksLikeFileName(name: string): boolean {
  return /^[^\s]+$/.test(name) || /\.[A-Za-z0-9]{1,8}$/.test(name);
}

// ---- icons -------------------------------------------------------------------------------------

function icon(paths: string, size = 16): Raw {
  return raw(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`,
  );
}

export const waveMark = raw(
  `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M4 13c3 0 3-3 6-3s3 3 6 3 3-3 6-3 3 3 6 3M4 21c3 0 3-3 6-3s3 3 6 3 3-3 6-3 3 3 6 3" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`,
);

export const icons = {
  clock: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  lock: icon(
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  ),
  people: icon(
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  ),
  upload: icon(
    '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    28,
  ),
  file: icon(
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    14,
  ),
  chat: icon('<path d="M4 5h11v8H8l-4 3z"/><path d="M15 9h5v8l-3-2.5h-6.5V13"/>'),
  person: icon('<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>', 13),
  waves: icon(
    '<path d="M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 16c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/>',
    32,
  ),
};

const SESSION_ICONS: Record<SessionType, Raw> = {
  chat: icon('<path d="M4 5h16v11H9l-5 4z"/>', 13),
  local_coding: icon(
    '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M7 9l3 2-3 2M12 13h4"/>',
    13,
  ),
  hosted_coding: icon(
    '<path d="M7 18a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.6A3.8 3.8 0 0 1 17.5 18z"/><path d="M10 12l-2 2 2 2M14 12l2 2-2 2"/>',
    13,
  ),
  persistent_agent: icon(
    '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><circle cx="12" cy="12" r="2"/>',
    13,
  ),
};

export const SESSION_LABELS: Record<SessionType, string> = {
  chat: "Chat",
  local_coding: "Local coding",
  hosted_coding: "Hosted coding",
  persistent_agent: "Persistent agent",
};

export function sessionChip(type: SessionType): Raw {
  return html`<span class="chip">${SESSION_ICONS[type]}${SESSION_LABELS[type]}</span>`;
}

// ---- building blocks ---------------------------------------------------------------------------

export function csrfField(token: string): Raw {
  return html`<input type="hidden" name="csrf" value="${token}">`;
}

/** A GitHub avatar over an initial, so a blocked or slow image still leaves something. */
export function avatar(account: { id: number; login: string }, small = false): Raw {
  const px = small ? 44 : 64;
  return html`<span class="avatar${small ? " sm" : ""}" title="${account.login}" aria-hidden="true">${account.login.slice(0, 1)}<img src="https://avatars.githubusercontent.com/u/${String(account.id)}?s=${String(px)}&amp;v=4" alt="" width="${String(px / 2)}" height="${String(px / 2)}" loading="lazy" decoding="async"></span>`;
}

/** A row of overlapping avatars; screen readers get the logins as text. */
export function faces(accounts: { id: number; login: string }[], label: string): Raw {
  if (accounts.length === 0) return html``;
  return html`<ul class="faces" aria-label="${label}">${accounts.map(
    (a) => html`<li>${avatar(a, true)}<span class="sr-only">${a.login}</span></li>`,
  )}</ul>`;
}

/** Avatars with their logins beside them; past `limit`, a "+N more" naming the rest. */
/** Share-list avatars with logins; the viewer is listed first, as "you". */
export function sharedWith(
  accounts: { id: number; login: string }[],
  viewerId: number,
  limit = Infinity,
): Raw {
  const ordered = [...accounts].sort(
    (a, b) => Number(b.id === viewerId) - Number(a.id === viewerId),
  );
  const shown = ordered.slice(0, limit);
  const rest = ordered.slice(limit).map((a) => a.login);
  return html`<ul class="who">${shown.map((a) =>
    a.id === viewerId
      ? html`<li>${avatar(a, true)}<span>you</span></li>`
      : html`<li>${avatar(a, true)}<span class="mono">${a.login}</span></li>`,
  )}${
    rest.length > 0
      ? html`<li class="more" title="${rest.join(", ")}">+${String(rest.length)} more<span class="sr-only">: ${rest.join(", ")}</span></li>`
      : ""
  }</ul>`;
}

export type PillKind = "ready" | "uploading" | "expired" | "paused" | "pending";

const PILL_TEXT: Record<PillKind, string> = {
  ready: "Ready",
  uploading: "Uploading",
  expired: "Expired",
  paused: "Paused",
  pending: "Pending invite",
};

export function pill(kind: PillKind, text = PILL_TEXT[kind]): Raw {
  return html`<span class="pill ${kind}">${text}</span>`;
}

/** Relative time, with the exact UTC time on hover; the script keeps it fresh. */
export function timeEl(ms: number, now: number): Raw {
  return html`<time datetime="${isoText(ms)}" title="${utcText(ms)}" data-rel>${relativeText(ms, now)}</time>`;
}

/** "22:46 UTC" from the server; the script shows the viewer's local clock time, UTC on hover. */
export function clockEl(ms: number): Raw {
  return html`<time datetime="${isoText(ms)}" title="${utcText(ms)}" data-clock>${utcText(ms).slice(11, 16)} UTC</time>`;
}

function isoText(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The tide bar: drains as a file's time runs out, and turns amber under two minutes. */
export function tide(expiresAt: number, lifetimeMinutes: number, now: number): Raw {
  const total = lifetimeMinutes * 60_000;
  const rest = expiresAt - now;
  const pct = Math.max(0, Math.min(100, Math.round(((rest / total) * 100) / 5) * 5));
  return html`<div class="timer${rest < 120_000 ? " low" : ""}" data-end="${String(expiresAt)}" data-total="${String(total)}">
<div class="tide" role="presentation"><span class="w${String(pct)}"></span></div>
<span class="left">${timeLeftText(rest)}</span>
</div>`;
}

/** A read-only block with a copy button (shown by the script) and a select-all fallback. */
export function copyBlock(
  id: string,
  value: string,
  label: string,
  options: { large?: boolean; guard?: boolean } = {},
): Raw {
  const large = options.large ?? false;
  return html`<div class="copy${large ? " lg" : ""}">
<code id="${id}">${value}</code>
<button type="button" class="btn${large ? " primary" : ""}" data-copy="${id}" aria-label="${label}"${
    options.guard ? html` data-guard` : ""
  } hidden>Copy</button>
<noscript><p class="hint">Click the text to select it, then copy.</p></noscript>
</div>`;
}

export function flashBanner(flash: Flash | null): Raw {
  if (!flash) return html``;
  return html`<div class="flash ${flash.kind}" role="${flash.kind === "error" ? "alert" : "status"}"><p>${flash.message}</p></div>`;
}

export function emptyState(lead: string, detail: Raw | string, action?: Raw): Raw {
  return html`<div class="card empty">${icons.waves}<p class="lead">${lead}</p><p class="muted">${detail}</p>${action ?? ""}</div>`;
}

/**
 * Destructive actions confirm in place, with no modal: a <details> whose summary is the first
 * button and whose panel holds the real one.
 */
export function confirmForm(options: {
  action: string;
  csrf: string;
  summary: string;
  explain: string;
  confirm: string;
  hidden?: Record<string, string>;
  inline?: boolean;
  danger?: boolean;
}): Raw {
  const danger = options.danger ?? true;
  return html`<details class="confirm${options.inline ? " inline" : ""}">
<summary class="btn small ${danger ? "quiet-danger" : "quiet"}">${options.summary}</summary>
<div class="confirm-panel">
<p>${options.explain}</p>
<form method="post" action="${options.action}">${csrfField(options.csrf)}${Object.entries(
    options.hidden ?? {},
  ).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<button type="submit" class="btn small ${danger ? "danger" : ""}">${options.confirm}</button>
</form>
</div>
</details>`;
}

/** A one-button POST form. */
export function postButton(
  action: string,
  csrf: string,
  label: string,
  style = "btn",
  hidden: Record<string, string> = {},
): Raw {
  return html`<form method="post" action="${action}">${csrfField(csrf)}${Object.entries(hidden).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`,
  )}<button type="submit" class="${style}">${label}</button></form>`;
}

/** An inline field error, wired to its input with aria-describedby. */
export function fieldError(id: string, message: string | null): Raw {
  return html`<p class="field-error" id="${id}" tabindex="-1"${message ? "" : raw(" hidden")}>${message ?? ""}</p>`;
}
