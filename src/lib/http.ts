export function text(status: number, message: string, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "text/plain; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(`${message}\n`, { status, headers: h });
}

/** A JSON response that is never cached or sniffed. */
export function json(status: number, value: unknown, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { status, headers: h });
}

/** True if a declared Content-Length is over `max`. */
export function declaredOver(request: Request, max: number): boolean {
  const header = request.headers.get("Content-Length");
  return header !== null && Number(header) > max;
}

/**
 * Reads a whole body, but at most `max` bytes: null if it is longer. For bodies sent without a
 * Content-Length (chunked), which would otherwise be buffered whole by `text()` or `formData()`.
 */
export async function readCapped(body: ReadableStream<Uint8Array>, max: number) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export function redirect(location: string, headers: HeadersInit = {}, status = 302): Response {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status, headers: h });
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number, path = "/"): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string, path = "/"): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * A redirect target that stays on this origin: "/x", never "//x", "/\x" or anything with
 * whitespace or control characters, which browsers may turn into another host.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || value[i] === "\\") return null;
  }
  return value;
}
