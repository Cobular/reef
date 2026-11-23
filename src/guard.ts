import { sessionUserId } from "./auth/portal";
import { AUTH_PATHS, MAX_FORM_BODY_BYTES, MAX_MCP_BODY_BYTES, RATE_LIMITS } from "./config";
import { verifyToken } from "./files/tokens";
import { declaredOver, json, readCapped, text } from "./lib/http";
import { clientIp, type LimitName, limitMessage, overLimit } from "./lib/rate-limit";
import type { Portal } from "./portal/context";
import { errorScreen } from "./portal/layout";

/** Who is asking decides the shape of a refusal: curl, an MCP client, an OAuth client, a person. */
type Surface = "data" | "mcp" | "oauth" | "page";

function surfaceOf(request: Request): Surface {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/up/") || path.startsWith("/dl/")) return "data";
  if (path === "/mcp" || path.startsWith("/mcp/")) return "mcp";
  if (path.startsWith("/oauth/") || path.startsWith("/.well-known/")) return "oauth";
  return "page";
}

/** `PUT /up/...` bodies are file bytes: they stream to R2 untouched and are never read here. */
function isStreamedUpload(request: Request): boolean {
  return request.method === "PUT" && new URL(request.url).pathname.startsWith("/up/");
}

/**
 * Cheap checks before any routing, D1, KV or R2 work: the per-IP limits, then the body size.
 * Returns a refusal, or the request to serve (rebuilt if its body had to be read to measure it).
 */
export async function guardRequest(request: Request, env: Env): Promise<Response | Request> {
  const ip = clientIp(request);
  if (ip) {
    const limit = await floodLimit(request, env, ip);
    if (limit && (await overLimit(env, limit.name, limit.key)))
      return rateLimited(request, env, limit.name);
    if (AUTH_PATHS.includes(new URL(request.url).pathname) && (await overLimit(env, "auth", ip)))
      return rateLimited(request, env, "auth");
  }
  if (!request.body || isStreamedUpload(request)) return request;
  const max = surfaceOf(request) === "mcp" ? MAX_MCP_BODY_BYTES : MAX_FORM_BODY_BYTES;
  if (declaredOver(request, max)) return tooLarge(request, env, max);
  if (request.headers.has("Content-Length")) return request;
  const body = await readCapped(request.body, max);
  if (!body) return tooLarge(request, env, max);
  return new Request(request, { body });
}

/**
 * Which flood limit a request counts against, decided by credentials that cost only CPU to check,
 * so many people behind one IP (a vendor's MCP egress, an office) don't share one bucket:
 * - a valid portal session cookie: per account;
 * - a validly signed `/up` or `/dl` token: none here, because the data API's per-account limit
 *   runs straight after the same signature check;
 * - a bearer token on `/mcp`: a much larger per-IP bucket (validating it needs KV), followed by
 *   the per-account MCP limit once the OAuth provider has checked it;
 * - anything else: per IP.
 */
async function floodLimit(
  request: Request,
  env: Env,
  ip: string,
): Promise<{ name: LimitName; key: string } | null> {
  const path = new URL(request.url).pathname;
  const data = /^\/(up|dl)\/([^/]+)/.exec(path);
  if (data) {
    const action = data[1] as "up" | "dl";
    if (await verifyToken(env.TOKEN_SIGNING_KEY, data[2] ?? "", action)) return null;
    return { name: "ip", key: ip };
  }
  if (
    (path === "/mcp" || path.startsWith("/mcp/")) &&
    /^Bearer\s/i.test(request.headers.get("Authorization") ?? "")
  )
    return { name: "bearer", key: ip };
  if (request.headers.has("Cookie")) {
    const uid = await sessionUserId(request, env);
    if (uid !== null) return { name: "account", key: String(uid) };
  }
  return { name: "ip", key: ip };
}

/** 429 with Retry-After and the limit's message, in the caller's format. */
export function rateLimited(request: Request, env: Env, name: LimitName): Promise<Response> {
  return refuse(request, env, 429, "Slow down", limitMessage(name), RATE_LIMITS[name].period);
}

function tooLarge(request: Request, env: Env, max: number): Promise<Response> {
  return refuse(
    request,
    env,
    413,
    "Request too large",
    `The request body is too large: the limit here is ${max / 1024} KiB.`,
  );
}

async function refuse(
  request: Request,
  env: Env,
  status: number,
  title: string,
  message: string,
  retryAfter?: number,
): Promise<Response> {
  const headers: Record<string, string> = retryAfter ? { "Retry-After": String(retryAfter) } : {};
  switch (surfaceOf(request)) {
    case "data":
      return text(status, message, headers);
    case "mcp":
      return mcpRefusal(request, status, message, headers);
    case "oauth":
      return json(
        status,
        { error: status === 429 ? "rate_limited" : "invalid_request", error_description: message },
        headers,
      );
    case "page": {
      // The browser upload form posts with Accept: application/json and shows `error.message`.
      if ((request.headers.get("Accept") ?? "").includes("application/json"))
        return json(status, { error: { field: "form", message } }, headers);
      const response = errorScreen(signedOut(request, env), status, title, message);
      for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      return response;
    }
  }
}

/** A portal context without a session, so an error page costs no D1 read. */
function signedOut(request: Request, env: Env): Portal {
  return {
    request,
    env,
    url: new URL(request.url),
    now: Date.now(),
    user: null,
    csrf: null,
    admin: false,
    flash: null,
    partSize: 0,
  };
}

/**
 * A refused MCP request. A rate-limited `tools/call` gets a normal tool error result (HTTP 200),
 * which the session reads and can act on; anything else gets the HTTP status and a JSON-RPC
 * error. Only a 429 reads the body (it is already known to be small); a 413 never does.
 */
export async function mcpRefusal(
  request: Request,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  let id: string | number | null = null;
  if (status === 429 && request.body) {
    const body = await readCapped(request.body, MAX_MCP_BODY_BYTES);
    let rpc: unknown = null;
    try {
      rpc = body ? JSON.parse(new TextDecoder().decode(body)) : null;
    } catch {}
    if (rpc && typeof rpc === "object" && !Array.isArray(rpc)) {
      const r = rpc as { id?: unknown; method?: unknown };
      if (typeof r.id === "string" || typeof r.id === "number") id = r.id;
      if (r.method === "tools/call" && id !== null)
        return json(
          200,
          {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: message }], isError: true },
          },
          headers,
        );
    }
  }
  return json(status, { jsonrpc: "2.0", id, error: { code: -32000, message } }, headers);
}

/**
 * `X-Content-Type-Options: nosniff` on every response, and `Cache-Control: no-store` on any that
 * does not set its own caching (JSON, tokens, file bytes, MCP results). HTML pages and static
 * assets already set both.
 */
export function withSecurityHeaders(response: Response): Response {
  const sniff = !response.headers.has("X-Content-Type-Options");
  const cache = !response.headers.has("Cache-Control");
  if ((!sniff && !cache) || response.status === 101) return response;
  const apply = (r: Response) => {
    if (sniff) r.headers.set("X-Content-Type-Options", "nosniff");
    if (cache) r.headers.set("Cache-Control", "no-store");
    return r;
  };
  try {
    return apply(response);
  } catch {
    // Immutable headers (Response.redirect, fetched responses): copy, keeping the body stream.
    return apply(new Response(response.body, response));
  }
}
