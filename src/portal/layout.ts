import { html, htmlResponse, PORTAL_CSP, type Raw } from "../lib/html";
import { ASSET_URLS } from "./assets";
import { avatar, csrfField, flashBanner, waveMark } from "./components";
import { flashClear, type Portal } from "./context";

export type Section = "files" | "schools" | "admin" | "account" | null;

export interface PageOptions {
  title: string;
  section?: Section;
  status?: number;
  /** Show the flash banner (on by default). */
  flash?: boolean;
  headers?: HeadersInit;
}

function navLink(href: string, label: string, current: boolean): Raw {
  return html`<a href="${href}"${current ? html` aria-current="page"` : ""}>${label}</a>`;
}

function header(p: Portal, section: Section): Raw {
  const user = p.user;
  const nav =
    user && p.csrf
      ? html`<nav class="nav" aria-label="Main">${navLink("/files", "Files", section === "files")}${navLink(
          "/schools",
          "Schools",
          section === "schools",
        )}${p.admin ? navLink("/admin", "Admin", section === "admin") : ""}</nav>
<div class="me"><a class="me-link" href="/account" title="Your account"${section === "account" ? html` aria-current="page"` : ""}>${avatar({ id: user.userId, login: user.login })}<span class="me-login mono">${user.login}</span></a>
<form method="post" action="/logout">${csrfField(p.csrf)}<button type="submit" class="btn small quiet" title="Signs this account out in every browser">Sign out</button></form></div>`
      : html`<div class="me"><a class="btn small" href="/login">Sign in</a></div>`;
  return html`<header class="top"><div class="wrap top-in">
<a class="brand" href="/">${waveMark}<span>Reef</span></a>
${nav}
</div></header>`;
}

const FOOTER_LINKS: [string, string][] = [
  ["Source", "https://github.com/Cobular/reef"],
  ["Security", "https://github.com/Cobular/reef/security/policy"],
  ["Privacy", "https://cobular.notion.site/Privacy-Policy-277b8e3e484e445193f01fb142529a69"],
  ["Terms", "/terms"],
  ["Report abuse", "https://github.com/Cobular/reef/issues/new?template=abuse-report.yml"],
];

const footer = html`<footer class="foot wrap">${FOOTER_LINKS.map(
  ([label, href]) => html`<a href="${href}">${label}</a>`,
)}</footer>`;

/** A full portal page in the shared layout, with the strict CSP and no inline script or style. */
export function render(p: Portal, options: PageOptions, body: Raw): Response {
  const showFlash = options.flash ?? true;
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${options.title} · Reef</title>
<link rel="stylesheet" href="${ASSET_URLS.css}">
<link rel="icon" href="${ASSET_URLS.favicon}" type="image/svg+xml">
<script src="${ASSET_URLS.js}" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header(p, options.section ?? null)}
<main id="main" class="main wrap" tabindex="-1">
${showFlash ? flashBanner(p.flash) : ""}
${body}
</main>
${footer}
<div id="live" class="sr-only" aria-live="polite"></div>
</body>
</html>`;
  const headers = new Headers(options.headers);
  const clear = showFlash ? flashClear(p) : null;
  if (clear) headers.append("Set-Cookie", clear);
  return htmlResponse(doc.value, PORTAL_CSP, { status: options.status ?? 200, headers });
}

/** 404, 403 and 500 pages, in the same layout, each with a fix and a way home. */
export function errorScreen(p: Portal, status: number, title: string, message: string): Response {
  const home = p.user ? "/files" : "/";
  return render(
    p,
    { title, status, flash: false },
    html`<div class="card narrow">
<h1>${title}</h1>
<p class="muted">${message}</p>
<a class="btn" href="${home}">${p.user ? "Back to your files" : "Go to the Reef home page"}</a>
</div>`,
  );
}

export function notFound(p: Portal): Response {
  return errorScreen(
    p,
    404,
    "Page not found",
    "There is nothing at this address. Check the link, or start again from home.",
  );
}

export function forbidden(p: Portal): Response {
  return errorScreen(
    p,
    403,
    "That form has expired",
    "Reef could not confirm this request came from your own Reef page. Go back, reload the page and try again.",
  );
}
