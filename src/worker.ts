import {
  getOAuthApi,
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import type { GitHubApi } from "./auth/github";
import { finishMcpLogin, MCP_CALLBACK_PATH, showConsent, submitConsent } from "./auth/mcp";
import { finishLogin, PORTAL_CALLBACK_PATH } from "./auth/portal";
import { ACCESS_TOKEN_TTL_SECONDS, PART_SIZE, publicOrigin } from "./config";
import { cleanup } from "./files/cleanup";
import { handleData } from "./files/http";
import { guardRequest, withSecurityHeaders } from "./guard";
import { logError } from "./lib/log";
import { mcpApiHandler } from "./mcp/server";
import { handlePortal } from "./portal/router";
import { cleanupSchools } from "./schools/cleanup";

export interface WorkerDeps {
  github: GitHubApi;
  /** Multipart part size; tests shrink it. Production uses 90 MiB. */
  partSize?: number;
}

/**
 * Builds the Worker. Request order:
 * 0. `guardRequest`: per-IP rate limits and request body size, before any storage is touched.
 * 1. `/up/*` and `/dl/*` (the data API) go straight to their handlers, so bodies stream untouched.
 * 2. Everything else goes through OAuthProvider: it serves the OAuth endpoints, guards `/mcp`
 *    with bearer tokens, and hands other paths to the app routes below.
 */
export function createWorker(deps: WorkerDeps) {
  const partSize = deps.partSize ?? PART_SIZE;
  const cache = new Map<
    string,
    { options: OAuthProviderOptions<Env>; provider: OAuthProvider<Env> }
  >();

  const app = {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const oauth = getOAuthApi(oauthFor(env).options, env);
      const route = `${request.method} ${url.pathname}`;
      switch (route) {
        case "GET /authorize":
          return showConsent(request, env, oauth, deps.github);
        case "POST /authorize":
          return submitConsent(request, env, oauth, deps.github);
        case `GET ${MCP_CALLBACK_PATH}`:
          return finishMcpLogin(request, env, oauth, deps.github);
        case `GET ${PORTAL_CALLBACK_PATH}`:
          return finishLogin(request, env, deps.github);
        default:
          return handlePortal(request, env, deps.github, partSize);
      }
    },
  };

  // The resource URL must be absolute and is fixed per provider, so build one per origin.
  function oauthFor(env: Env) {
    const origin = publicOrigin(env);
    let entry = cache.get(origin);
    if (!entry) {
      const options: OAuthProviderOptions<Env> = {
        apiRoute: "/mcp",
        apiHandler: mcpApiHandler(partSize),
        defaultHandler: app,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        clientIdMetadataDocumentEnabled: true,
        // A day, not the library's hour: each refresh writes KV twice and Free allows 1,000 KV
        // writes a day. Bans and account deletion still apply at once, because the MCP handler
        // looks the account up in D1 on every request.
        accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
        resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Reef" },
      };
      entry = { options, provider: new OAuthProvider(options) };
      cache.set(origin, entry);
    }
    return entry;
  }

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // Fail closed: the security gate redeploys with MAINTENANCE=1 when a production dependency
      // has a known high or critical vulnerability. The cleanup cron keeps running.
      if (env.MAINTENANCE === "1") return maintenance();
      const guarded = await guardRequest(request, env);
      if (guarded instanceof Response) return withSecurityHeaders(guarded);
      const data = await handleData(guarded, env, partSize);
      if (data) return withSecurityHeaders(data);
      return withSecurityHeaders(await oauthFor(env).provider.fetch(guarded, env, ctx));
    },

    async scheduled(controller: ScheduledController, env: Env) {
      await cleanup(env, controller.scheduledTime);
      // Message retention scans every school, so it runs on the first cron run of each hour.
      const messages = new Date(controller.scheduledTime).getUTCMinutes() < 5;
      await cleanupSchools(env.DB, controller.scheduledTime, { messages }).catch((error: unknown) =>
        logError("cron.schools_cleanup_failed", error),
      );
      // No OAuth KV sweep: every record the library writes (tokens, grants, client
      // registrations, transactions) carries a KV expiry, so purgeExpiredData would only find
      // stragglers while spending KV list and read operations.
    },
  } satisfies ExportedHandler<Env>;
}

function maintenance(): Response {
  return new Response(
    "Reef is offline while a security update is applied. Files expire as usual. Try again later.\n",
    {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": "3600",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
