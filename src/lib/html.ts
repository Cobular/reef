export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template that escapes every interpolation unless it is wrapped in `raw()`. */
export class Raw {
  constructor(readonly value: string) {}
}

export function raw(value: string): Raw {
  return new Raw(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    if (value instanceof Raw) out += value.value;
    else if (Array.isArray(value))
      out += value.map((v) => (v instanceof Raw ? v.value : escapeHtml(String(v)))).join("");
    else if (value !== null && value !== undefined && value !== false)
      out += escapeHtml(String(value));
    out += strings[i + 1] ?? "";
  });
  return new Raw(out);
}

const SECURITY_HEADERS: Record<string, string> = {
  // No form-action: browsers apply it to the redirect after a form post, and the consent form
  // redirects on to GitHub or the MCP client's own redirect URI.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export function page(
  title: string,
  body: Raw,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Reef</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#123}
h1{font-size:1.5rem}
.warn{background:#fff4d6;border:1px solid #e5c76b;padding:.5rem .75rem;border-radius:4px}
button{font-size:1rem;padding:.4rem 1rem;margin-right:.5rem}
code{background:#eef;padding:0 .25rem}
</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(doc.value, { status: init.status ?? 200, headers });
}

export function errorPage(status: number, title: string, message: string): Response {
  return page(title, html`<p>${message}</p>`, { status });
}
