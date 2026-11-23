import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { GitHubApi, GitHubUser } from "../src/auth/github";
import { bytesToHex } from "../src/lib/base64";
import { mcpApiHandler } from "../src/mcp/server";
import { createWorker } from "../src/worker";

/** 5 MiB, R2's minimum part size, so multipart tests stay small. */
export const TEST_PART_SIZE = 5 * 1024 * 1024;
export const ORIGIN = "https://reef.cobular.com";

/** GitHub stub: each OAuth `code` maps to a GitHub user. */
export function stubGitHub(users: Record<string, GitHubUser>) {
  const calls: { exchanges: { code: string; codeVerifier: string; redirectUri: string }[] } = {
    exchanges: [],
  };
  const api: GitHubApi = {
    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL("https://github.test/login/oauth/authorize");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      calls.exchanges.push({ code, codeVerifier, redirectUri });
      if (!users[code]) throw new Error("bad code");
      return `gh-token-${code}`;
    },
    async getUser(token) {
      const user = users[token.replace(/^gh-token-/, "")];
      if (!user) throw new Error("bad token");
      return user;
    },
  };
  return { api, calls };
}

const SSEC_META = "test-ssec-md5";
const uploadKeys = new Map<string, string>();

async function md5Hex(key: ArrayBuffer | string): Promise<string> {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("MD5", bytes)));
}

/**
 * Miniflare's R2 binding accepts `ssecKey` but ignores it (checked: a get with a different key
 * returns the plaintext). This wrapper emulates SSE-C at the binding boundary: it records the
 * key's MD5 on write and refuses reads and part uploads with a different key, the way R2 does.
 */
export function ssecBucket(inner: R2Bucket = env.BUCKET): R2Bucket {
  const bucket = {
    async put(key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) {
      const { ssecKey, ...rest } = options ?? {};
      const customMetadata = { ...(rest.customMetadata as Record<string, string> | undefined) };
      if (ssecKey) customMetadata[SSEC_META] = await md5Hex(ssecKey);
      return inner.put(key, value, { ...rest, customMetadata });
    },
    async head(key: string) {
      const object = await inner.head(key);
      if (!object) return null;
      return { ssecKeyMd5: object.customMetadata?.[SSEC_META], size: object.size };
    },
    async get(key: string, options?: R2GetOptions) {
      const { ssecKey, ...rest } = options ?? {};
      const object = await inner.head(key);
      if (!object) return null;
      const stored = object.customMetadata?.[SSEC_META];
      if (stored && (!ssecKey || (await md5Hex(ssecKey)) !== stored)) {
        // Deliberately vague, so Storage must diagnose the key through head().
        throw new Error("get: Bad Request (10001)");
      }
      return inner.get(key, rest);
    },
    async delete(keys: string | string[]) {
      return inner.delete(keys);
    },
    async createMultipartUpload(key: string, options?: R2MultipartOptions) {
      const { ssecKey, ...rest } = options ?? {};
      const customMetadata = { ...(rest.customMetadata as Record<string, string> | undefined) };
      const md5 = ssecKey ? await md5Hex(ssecKey) : undefined;
      if (md5) customMetadata[SSEC_META] = md5;
      const upload = await inner.createMultipartUpload(key, { ...rest, customMetadata });
      if (md5) uploadKeys.set(upload.uploadId, md5);
      return upload;
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      const upload = inner.resumeMultipartUpload(key, uploadId);
      return {
        key,
        uploadId,
        async uploadPart(n: number, value: ReadableStream, options?: R2UploadPartOptions) {
          const stored = uploadKeys.get(uploadId);
          if (stored && (!options?.ssecKey || (await md5Hex(options.ssecKey)) !== stored)) {
            throw new Error("uploadPart: The SSE-C key does not match the upload's key");
          }
          return upload.uploadPart(n, value);
        },
        complete: (parts: R2UploadedPart[]) => upload.complete(parts),
        abort: () => upload.abort(),
      };
    },
  };
  return bucket as unknown as R2Bucket;
}

export interface TestEnvOptions {
  signupMode?: "invite" | "open";
  bucket?: R2Bucket;
  /** Rate limiters by binding name (RL_IP, ...); any not given always allow. */
  limiters?: Partial<Record<RateLimitBinding, RateLimit>>;
}

export type RateLimitBinding = "RL_IP" | "RL_AUTH" | "RL_MCP" | "RL_WRITE" | "RL_DATA";

/** A rate limiter stub that records each key and refuses those `deny` picks (default all). */
export function stubLimiter(deny: (key: string) => boolean = () => true) {
  const keys: string[] = [];
  const limiter: RateLimit = {
    async limit({ key }) {
      keys.push(key);
      return { success: !deny(key) };
    },
  };
  return { limiter, keys };
}

const allow = stubLimiter(() => false).limiter;

export function testEnv(options: TestEnvOptions = {}): Env {
  return {
    ...env,
    BUCKET: options.bucket ?? ssecBucket(),
    SIGNUP_MODE: options.signupMode ?? "invite",
    // The real local limiters would count across tests; stubs keep tests independent.
    RL_IP: allow,
    RL_AUTH: allow,
    RL_MCP: allow,
    RL_WRITE: allow,
    RL_DATA: allow,
    ...options.limiters,
  } as unknown as Env;
}

export function testWorker(github: GitHubApi = stubGitHub({}).api) {
  return createWorker({ github, partSize: TEST_PART_SIZE });
}

/** Calls the worker directly (not through SELF) so tests can inject stubs and env. */
export async function call(
  worker: ReturnType<typeof createWorker>,
  request: Request,
  workerEnv: Env = testEnv(),
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// ---- database ------------------------------------------------------------------------------

export async function resetDb(): Promise<void> {
  await env.DB.batch(
    [
      "DELETE FROM messages",
      "DELETE FROM read_positions",
      "DELETE FROM sessions",
      "DELETE FROM school_members",
      "DELETE FROM schools",
      "DELETE FROM upload_parts",
      "DELETE FROM file_shares",
      "DELETE FROM files",
      "DELETE FROM invites",
      "DELETE FROM users",
      "DELETE FROM service_stats",
    ].map((sql) => env.DB.prepare(sql)),
  );
}

export async function addUser(id: number, login: string, banned = false): Promise<void> {
  await env.DB.prepare("INSERT INTO users (id, login, created_at, banned) VALUES (?, ?, ?, ?)")
    .bind(id, login, Date.now(), banned ? 1 : 0)
    .run();
}

export async function invite(login: string): Promise<void> {
  await env.DB.prepare("INSERT INTO invites (login, created_at) VALUES (?, ?)")
    .bind(login, Date.now())
    .run();
}

export async function fileRow(id: string) {
  return env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<{
    state: string;
    expires_at: number | null;
    download_count: number;
    r2_upload_id: string | null;
  }>();
}

// ---- MCP -----------------------------------------------------------------------------------

let rpcId = 0;

/** Reads a JSON-RPC response that may arrive as JSON or as an SSE stream. */
export async function readRpc(response: Response): Promise<{
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}> {
  const body = await response.text();
  if ((response.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
    const data = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    return JSON.parse(data[data.length - 1] ?? "{}");
  }
  return JSON.parse(body);
}

export function rpcRequest(method: string, params: Record<string, unknown> = {}, bearer?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
}

/** Sends one JSON-RPC request to /mcp as an already-authorised account, bypassing the OAuth layer. */
export async function rpcAs(
  user: { userId: number; login: string },
  method: string,
  params: Record<string, unknown> = {},
  workerEnv: Env = testEnv(),
  handler = mcpApiHandler(TEST_PART_SIZE),
) {
  const ctx = createExecutionContext();
  const authed = Object.assign(Object.create(ctx), { props: user }) as ExecutionContext;
  const rpc = await readRpc(await handler.fetch(rpcRequest(method, params), workerEnv, authed));
  if (rpc.error) throw new Error(`JSON-RPC error ${rpc.error.code}: ${rpc.error.message}`);
  return rpc.result ?? {};
}

/** Calls an MCP tool as an already-authorised account, bypassing the OAuth layer. */
export async function callTool(
  user: { userId: number; login: string },
  name: string,
  args: Record<string, unknown> = {},
  workerEnv: Env = testEnv(),
  handler = mcpApiHandler(TEST_PART_SIZE),
): Promise<{ text: string; isError: boolean }> {
  const result = (await rpcAs(
    user,
    "tools/call",
    { name, arguments: args },
    workerEnv,
    handler,
  )) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}
