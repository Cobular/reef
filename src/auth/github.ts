import { sha256Base64Url } from "../lib/crypto";

/**
 * The only module that talks to GitHub. Tests replace it with a stub (see `createWorker`).
 * Reef asks for no scopes: it needs only the numeric ID and login, and discards the GitHub
 * token straight after reading them.
 */
export interface GitHubUser {
  id: number;
  login: string;
}

export interface GitHubApi {
  authorizeUrl(params: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string;
  exchangeCode(params: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<string>;
  getUser(accessToken: string): Promise<GitHubUser>;
}

const USER_AGENT = "reef (https://reef.cobular.com)";

export const githubApi: GitHubApi = {
  authorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },

  async exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
    };
    if (!response.ok || !data.access_token) {
      throw new Error(`GitHub token exchange failed: ${data.error ?? response.status}`);
    }
    return data.access_token;
  },

  async getUser(accessToken) {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub /user failed: ${response.status}`);
    const data = (await response.json()) as { id?: unknown; login?: unknown };
    if (typeof data.id !== "number" || typeof data.login !== "string") {
      throw new Error("GitHub /user returned no id or login");
    }
    return { id: data.id, login: data.login };
  },
};

/** PKCE (RFC 7636) S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}
