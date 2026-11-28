import {
  AuthorizationError,
  type AuthRequest,
  authorizationErrorRedirect,
  CimdFetchError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { publicOrigin } from "../config";
import { randomToken } from "../lib/crypto";
import { errorPage, html, page } from "../lib/html";
import { logError, logEvent } from "../lib/log";
import type { McpProps } from "../mcp/server";
import { type GitHubApi, pkceChallenge } from "./github";
import { admit, refusalPage } from "./signup";

export const MCP_CALLBACK_PATH = "/auth/callback/mcp";

interface UpstreamData {
  verifier: string;
}

function rememberOptions(env: Env) {
  return { secret: env.COOKIE_SECRET };
}

/** Maps the library's authorization errors to a redirect (when safe) or a local error page. */
function authorizationFailure(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return errorPage(400, "Sign-in request refused", error.description);
  }
  if (error instanceof CimdFetchError) {
    return errorPage(400, "Unknown app", "Reef could not read this app's client metadata.");
  }
  throw error;
}

/** GET /authorize: validate the MCP client's request and show the consent page. */
export async function showConsent(
  request: Request,
  env: Env,
  oauth: OAuthHelpers,
  github: GitHubApi,
): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await oauth.parseAuthRequest(request);
    if (await oauth.isConsentRemembered(request, authRequest, rememberOptions(env))) {
      return await toGitHub(env, oauth, github, authRequest, new Headers());
    }
    const consent = await oauth.describeConsent(authRequest);
    const tx = await oauth.beginConsent(authRequest);
    const shownName = consent.clientDomain ?? consent.clientName;
    return page(
      "Connect to Reef",
      html`<p><strong>${shownName}</strong> wants to use Reef as your account. It will be able
          to create, list, share, download and delete your Reef files, and to read and send
          messages in your Reef schools.</p>
        ${consent.clientDomain ? "" : html`<p>The app named itself; Reef has not verified that name.</p>`}
        <p>After you approve, you sign in with GitHub, and the app's tokens go to
          <code>${consent.redirectHost}</code>.</p>
        ${
          consent.redirectIsLoopback
            ? html`<p class="warn">This sends tokens to a program on your own computer. Any program
                running there could be listening, whatever name it gives. Approve only if you just
                started this connection yourself.</p>`
            : ""
        }
        <form method="post" action="/authorize">
          <input type="hidden" name="handle" value="${tx.handle}">
          <p><label><input type="checkbox" name="remember" value="1"> Remember this app on this
            browser for 30 days</label></p>
          <button type="submit" name="action" value="approve">Approve</button>
          <button type="submit" name="action" value="deny">Deny</button>
        </form>`,
      { headers: tx.headers },
    );
  } catch (error) {
    return authorizationFailure(error);
  }
}

/** POST /authorize: the consent form. Approve goes on to GitHub; deny returns to the app. */
export async function submitConsent(
  request: Request,
  env: Env,
  oauth: OAuthHelpers,
  github: GitHubApi,
): Promise<Response> {
  const form = await request.formData();
  const handle = form.get("handle");
  if (typeof handle !== "string")
    return errorPage(400, "Bad request", "The consent form is missing.");
  try {
    if (form.get("action") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(
      request,
      handle,
      form.get("remember") === "1" ? { remember: rememberOptions(env) } : undefined,
    );
    return await toGitHub(env, oauth, github, approved.request, approved.headers);
  } catch (error) {
    return authorizationFailure(error);
  }
}

async function toGitHub(
  env: Env,
  oauth: OAuthHelpers,
  github: GitHubApi,
  authRequest: AuthRequest,
  headers: Headers,
): Promise<Response> {
  const verifier = randomToken();
  const tx = await oauth.beginUpstream(authRequest, { data: { verifier }, headers });
  tx.headers.set(
    "Location",
    github.authorizeUrl({
      clientId: env.GITHUB_CLIENT_ID,
      redirectUri: `${publicOrigin(env)}${MCP_CALLBACK_PATH}`,
      state: tx.state,
      codeChallenge: await pkceChallenge(verifier),
    }),
  );
  tx.headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: tx.headers });
}

/** GET /auth/callback/mcp: GitHub returns here; finish the MCP client's authorization. */
export async function finishMcpLogin(
  request: Request,
  env: Env,
  oauth: OAuthHelpers,
  github: GitHubApi,
): Promise<Response> {
  let resumed: Awaited<ReturnType<OAuthHelpers["finishUpstream"]>>;
  try {
    // Checks `state` against the browser-bound cookie set by beginUpstream (CSRF), once only.
    resumed = await oauth.finishUpstream<UpstreamData>(request);
  } catch (error) {
    return authorizationFailure(error);
  }
  const data = resumed.data as Partial<UpstreamData> | undefined;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code || typeof data?.verifier !== "string") {
    return redirectWith(
      authorizationErrorRedirect(resumed.request, "access_denied"),
      resumed.headers,
    );
  }
  let user: Awaited<ReturnType<GitHubApi["getUser"]>>;
  try {
    const token = await github.exchangeCode({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      code,
      redirectUri: `${publicOrigin(env)}${MCP_CALLBACK_PATH}`,
      codeVerifier: data.verifier,
    });
    user = await github.getUser(token);
  } catch (error) {
    logError("auth.github_failed", error, { flow: "mcp" });
    return errorPage(502, "Sign-in failed", "GitHub sign-in failed. Start again from your app.");
  }
  const admission = await admit(env, user);
  if (!admission.ok) {
    const refused = refusalPage(admission);
    resumed.headers.forEach((value, name) => {
      if (name.toLowerCase() === "set-cookie") refused.headers.append(name, value);
    });
    return refused;
  }
  const props: McpProps = { userId: admission.userId, login: admission.login };
  const { redirectTo } = await oauth.completeAuthorization({
    request: resumed.request,
    userId: String(admission.userId),
    metadata: { login: admission.login },
    scope: resumed.request.scope,
    props,
  });
  logEvent("auth.mcp_authorized", { user: admission.userId });
  return redirectWith(redirectTo, resumed.headers);
}

function redirectWith(location: string, headers: Headers): Response {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: h });
}
