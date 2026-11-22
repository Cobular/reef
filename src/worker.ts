import {
  getOAuthApi,
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import type { GitHubApi } from "./auth/github";
import { finishMcpLogin, MCP_CALLBACK_PATH, showConsent, submitConsent } from "./auth/mcp";
import { finishLogin, PORTAL_CALLBACK_PATH } from "./auth/portal";
import { PART_SIZE, publicOrigin } from "./config";
import { cleanup } from "./files/cleanup";
import { handleData } from "./files/http";
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
      const data = await handleData(request, env, partSize);
      if (data) return data;
      return oauthFor(env).provider.fetch(request, env, ctx);
    },

    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
      await cleanup(env, controller.scheduledTime);
      await cleanupSchools(env.DB, controller.scheduledTime).catch((error: unknown) =>
        logError("cron.schools_cleanup_failed", error),
      );
      // KV entries expire by TTL; a daily sweep of leftovers is enough.
      const at = new Date(controller.scheduledTime);
      if (at.getUTCHours() === 3 && at.getUTCMinutes() < 5) {
        ctx.waitUntil(
          oauthFor(env)
            .provider.purgeExpiredData(env)
            .then(() => undefined)
            .catch((error: unknown) => logError("cron.oauth_purge_failed", error)),
        );
      }
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
      },
    },
  );
}
