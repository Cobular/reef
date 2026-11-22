import { publicOrigin } from "../config";
import { text } from "../lib/http";
import { logError, logEvent } from "../lib/log";
import { utc } from "./commands";
import { parseKey } from "./key";
import { fixedLengthBody } from "./limit-stream";
import { parseRange } from "./range";
import {
  canAccess,
  countDownload,
  deleteParts,
  type FileRow,
  getFile,
  isActiveUser,
  listParts,
  markReady,
  recordPart,
} from "./repo";
import { assertDownloadable, type FilesContext, filesContext, ReefError } from "./service";
import { WrongKeyError } from "./storage";
import { type TokenClaims, verifyToken } from "./tokens";

/**
 * The HTTP data API (DESIGN.md "HTTP data API"). Every request is authorised by the signed
 * token in its path and carries the file key in `X-Key` (or the `key` form field on
 * `POST /dl`). The key is never read from the URL, never logged and never stored.
 */
export async function handleData(
  request: Request,
  env: Env,
  partSize: number,
): Promise<Response | null> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").slice(1);
  const [area, token, tail, ...rest] = segments;
  if ((area !== "up" && area !== "dl") || !token || rest.length > 0) return null;
  try {
    const ctx = filesContext(env, partSize);
    if (area === "up") {
      if (tail === undefined) {
        if (request.method !== "PUT") return methodNotAllowed("PUT");
        return await uploadWhole(request, ctx, token);
      }
      if (tail === "complete") {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return await completeUpload(request, ctx, token);
      }
      if (request.method !== "PUT") return methodNotAllowed("PUT");
      return await uploadPart(request, ctx, token, tail);
    }
    if (tail !== undefined) return null;
    if (request.method === "GET") return await download(request, ctx, token, false);
    if (request.method === "POST") return await download(request, ctx, token, true);
    return methodNotAllowed("GET, POST");
  } catch (error) {
    if (error instanceof ReefError) return text(error.status, error.message);
    if (error instanceof WrongKeyError) return text(403, "Wrong key for this file.");
    logError("data.error", error, { area });
    return text(500, "Internal error.");
  }
}

function methodNotAllowed(allow: string): Response {
  return text(405, "Method not allowed.", { Allow: allow });
}

async function authorise(ctx: FilesContext, token: string, action: "up" | "dl") {
  const claims = await verifyToken(ctx.env.TOKEN_SIGNING_KEY, token, action, ctx.now);
  if (!claims) throw new ReefError(401, "Token is invalid or has expired. Ask Reef for a new one.");
  if (!(await isActiveUser(ctx.env.DB, claims.userId)))
    throw new ReefError(403, "This account is suspended.");
  return claims;
}

function requireKey(value: string | null): ArrayBuffer {
  const key = parseKey(value);
  if (!key) throw new ReefError(400, "Send the file key, 32 bytes base64, in the X-Key header.");
  return key;
}

// ---- uploads -------------------------------------------------------------------------------

async function pendingUpload(ctx: FilesContext, claims: TokenClaims): Promise<FileRow> {
  const file = await getFile(ctx.env.DB, claims.fileId);
  if (!file || file.owner_id !== claims.userId)
    throw new ReefError(401, "Token does not match a file.");
  if (file.state === "deleted") throw new ReefError(410, "The file has expired or been deleted.");
  if (file.state === "ready") throw new ReefError(409, "This file is already uploaded.");
  return file;
}

function checkContentLength(request: Request, expected: number): void {
  const header = request.headers.get("Content-Length");
  if (header === null)
    throw new ReefError(411, `Content-Length is required; this body must be ${expected} bytes.`);
  if (!/^\d+$/.test(header)) throw new ReefError(400, "Content-Length is not a number.");
  const length = Number(header);
  if (length > expected)
    throw new ReefError(413, `Body is larger than declared: expected ${expected} bytes.`);
  if (length !== expected)
    throw new ReefError(400, `Body is ${length} bytes; expected ${expected} bytes.`);
}

function lengthFailure(expected: number, error: unknown): never {
  if (error instanceof Error && /length|stream|closed|aborted|lost/i.test(error.message))
    throw new ReefError(400, `Body did not match the declared size of ${expected} bytes.`);
  throw error;
}

function partCount(file: FileRow, partSize: number): number {
  return file.size > partSize ? Math.ceil(file.size / partSize) : 1;
}

async function finish(ctx: FilesContext, file: FileRow): Promise<Response> {
  const expiresAt = await markReady(ctx.env.DB, file.id, ctx.now);
  if (expiresAt === null) {
    // Deleted while uploading: do not leave the bytes behind.
    await ctx.storage.delete([file.id]);
    throw new ReefError(410, "The file was deleted during the upload.");
  }
  logEvent("file.uploaded", { file: file.id, user: file.owner_id, size: file.size });
  return text(
    200,
    `Uploaded ${file.name} (${file.size} bytes) as file ${file.id}. It expires ${utc(expiresAt)}.`,
  );
}

async function uploadWhole(request: Request, ctx: FilesContext, token: string) {
  const claims = await authorise(ctx, token, "up");
  const key = requireKey(request.headers.get("X-Key"));
  const file = await pendingUpload(ctx, claims);
  if (file.r2_upload_id)
    throw new ReefError(
      400,
      `This file uploads in parts: PUT ${publicOrigin(ctx.env)}/up/<token>/<n>.`,
    );
  checkContentLength(request, file.size);
  try {
    await ctx.storage.put(
      file.id,
      file.size === 0 ? new ArrayBuffer(0) : fixedLengthBody(request.body, file.size),
      key,
    );
  } catch (error) {
    lengthFailure(file.size, error);
  }
  return finish(ctx, file);
}

async function uploadPart(request: Request, ctx: FilesContext, token: string, part: string) {
  const claims = await authorise(ctx, token, "up");
  const key = requireKey(request.headers.get("X-Key"));
  const file = await pendingUpload(ctx, claims);
  if (!file.r2_upload_id)
    throw new ReefError(400, "This file is small enough for one PUT to /up/<token>.");
  const total = partCount(file, ctx.partSize);
  const n = /^\d{1,5}$/.test(part) ? Number(part) : 0;
  if (n < 1 || n > total) throw new ReefError(400, `Part number must be 1 to ${total}.`);
  const expected = n < total ? ctx.partSize : file.size - ctx.partSize * (total - 1);
  checkContentLength(request, expected);
  let etag: string;
  try {
    etag = await ctx.storage.uploadPart(
      file.id,
      file.r2_upload_id,
      n,
      fixedLengthBody(request.body, expected),
      key,
    );
  } catch (error) {
    if (error instanceof WrongKeyError) throw error;
    lengthFailure(expected, error);
  }
  await recordPart(ctx.env.DB, file.id, n, etag, ctx.now);
  return text(200, `Part ${n} of ${total} received.`);
}

async function completeUpload(request: Request, ctx: FilesContext, token: string) {
  const claims = await authorise(ctx, token, "up");
  requireKey(request.headers.get("X-Key"));
  const file = await pendingUpload(ctx, claims);
  if (!file.r2_upload_id)
    throw new ReefError(400, "This file is uploaded with one PUT; there is nothing to complete.");
  const total = partCount(file, ctx.partSize);
  const parts = await listParts(ctx.env.DB, file.id);
  const have = new Set(parts.map((p) => p.partNumber));
  const missing: number[] = [];
  for (let i = 1; i <= total; i++) if (!have.has(i)) missing.push(i);
  if (missing.length > 0)
    throw new ReefError(400, `Missing parts: ${missing.join(", ")}. Upload them, then complete.`);
  try {
    await ctx.storage.completeMultipart(file.id, file.r2_upload_id, parts);
  } catch (error) {
    logError("upload.complete_failed", error, { file: file.id });
    throw new ReefError(502, "Storage refused to finish the upload. Call create_upload again.");
  }
  const response = await finish(ctx, file);
  await deleteParts(ctx.env.DB, file.id);
  return response;
}

// ---- downloads -----------------------------------------------------------------------------

/** Limits the portal form body; it only carries the key. */
const MAX_FORM_BYTES = 4096;

async function formKey(request: Request): Promise<string | null> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_FORM_BYTES) throw new ReefError(413, "Form body too large.");
  const type = request.headers.get("Content-Type") ?? "";
  if (
    !type.startsWith("application/x-www-form-urlencoded") &&
    !type.startsWith("multipart/form-data")
  )
    throw new ReefError(400, "Send the key as the form field `key`.");
  const form = await request.formData();
  const value = form.get("key");
  return typeof value === "string" ? value : null;
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function download(request: Request, ctx: FilesContext, token: string, form: boolean) {
  const claims = await authorise(ctx, token, "dl");
  const key = requireKey(form ? await formKey(request) : request.headers.get("X-Key"));
  const file = await getFile(ctx.env.DB, claims.fileId);
  if (!file) throw new ReefError(410, "The file has expired or been deleted.");
  if (!(await canAccess(ctx.env.DB, file, claims.userId)))
    throw new ReefError(401, "This file is no longer shared with you.");
  await assertDownloadable(ctx, file, false);

  const range = form ? null : parseRange(request.headers.get("Range"), file.size);
  if (range === "unsatisfiable")
    return text(416, "Range not satisfiable.", { "Content-Range": `bytes */${file.size}` });
  // Only a request that includes the first byte counts as a download, so resumes are free and
  // still work after the limit is used up (DESIGN.md "Download limit").
  const counts = range === null || range.offset === 0;
  if (counts && file.download_limit !== null && file.download_count >= file.download_limit)
    throw new ReefError(410, "The file's download limit is used up.");

  const object = await ctx.storage.get(file.id, key, range ?? undefined);
  if (!object) throw new ReefError(410, "The file has expired or been deleted.");
  if (counts && !(await countDownload(ctx.env.DB, file.id, ctx.now))) {
    await object.body.cancel();
    throw new ReefError(410, "The file's download limit is used up.");
  }
  logEvent("file.download", {
    file: file.id,
    user: claims.userId,
    counted: counts,
    ranged: !!range,
  });

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": contentDisposition(file.name),
    "Content-Length": String(range ? range.length : file.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`,
    );
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
