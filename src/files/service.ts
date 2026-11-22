import { LIMITS, publicOrigin, ROW_RETENTION_MS } from "../config";
import { randomId } from "../lib/crypto";
import { logEvent } from "../lib/log";
import {
  downloadCommand,
  fileNameProblem,
  handoffLine,
  multipartPython,
  multipartScript,
  uploadCommand,
} from "./commands";
import { generateKey, parseKey } from "./key";
import {
  canAccess,
  type FileRow,
  findUsersByLogins,
  getFile,
  getUser,
  insertFile,
  type ListedFile,
  listFilesFor,
  markDeleted,
  deleteParts as removeParts,
  residentBytes,
  setShares,
  shareLogins,
  shareUserIds,
  uploadsSince,
} from "./repo";
import { Storage } from "./storage";
import { issueToken } from "./tokens";

/** A refusal with a message safe to show the caller, and the HTTP status it maps to. */
export class ReefError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ReefError";
  }
}

export interface Caller {
  userId: number;
  login: string;
}

export interface FilesContext {
  env: Env;
  storage: Storage;
  partSize: number;
  now: number;
}

export function filesContext(env: Env, partSize: number, now = Date.now()): FilesContext {
  return { env, storage: new Storage(env.BUCKET), partSize, now };
}

export interface CreateUploadInput {
  name: string;
  size: number;
  lifetime_minutes?: number | undefined;
  download_limit?: number | undefined;
  share_with?: string[] | undefined;
  key?: string | undefined;
}

export interface CreatedUpload {
  file: FileRow;
  key: string;
  token: string;
  parts: number;
  command: string;
  python?: string;
  handoff: string;
  shareWith: string[];
}

export function uniqueLogins(logins: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of logins) {
    const login = raw.trim().replace(/^@/, "");
    if (login && !seen.has(login.toLowerCase())) seen.set(login.toLowerCase(), login);
  }
  return [...seen.values()];
}

/** Resolves logins to accounts; refuses any that are not existing, active accounts. */
async function resolveAccounts(db: D1Database, logins: string[]) {
  const users = (await findUsersByLogins(db, logins)).filter((u) => u.banned === 0);
  const found = new Set(users.map((u) => u.login.toLowerCase()));
  const missing = logins.filter((l) => !found.has(l.toLowerCase()));
  if (missing.length > 0) {
    throw new ReefError(
      400,
      `Not Reef accounts: ${missing.join(", ")}. Share lists only accept people who have signed in to Reef.`,
    );
  }
  return users;
}

export async function createUpload(
  ctx: FilesContext,
  caller: Caller,
  input: CreateUploadInput,
): Promise<CreatedUpload> {
  const db = ctx.env.DB;
  const nameProblem = fileNameProblem(input.name);
  if (nameProblem) throw new ReefError(400, nameProblem);
  if (!Number.isSafeInteger(input.size) || input.size < 0)
    throw new ReefError(400, "size must be a whole number of bytes");
  if (input.size > LIMITS.maxFileBytes)
    throw new ReefError(413, `File too large: the limit is ${LIMITS.maxFileBytes} bytes (10 GiB).`);
  const lifetime = input.lifetime_minutes ?? LIMITS.defaultLifetimeMinutes;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > LIMITS.maxLifetimeMinutes)
    throw new ReefError(400, `lifetime_minutes must be 1 to ${LIMITS.maxLifetimeMinutes}`);
  const limit = input.download_limit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1))
    throw new ReefError(400, "download_limit must be a whole number from 1");
  const key = input.key ?? generateKey();
  const keyBytes = parseKey(key);
  if (!keyBytes) throw new ReefError(400, "key must be 32 random bytes, base64-encoded");

  const logins = uniqueLogins(input.share_with ?? []).filter(
    (l) => l.toLowerCase() !== caller.login.toLowerCase(),
  );
  if (logins.length > LIMITS.maxShareList)
    throw new ReefError(400, `A share list holds at most ${LIMITS.maxShareList} accounts`);
  const shares = await resolveAccounts(db, logins);

  const dayAgo = ctx.now - 24 * 60 * 60 * 1000;
  if ((await uploadsSince(db, caller.userId, dayAgo)) >= LIMITS.maxUploadsPerAccountPerDay)
    throw new ReefError(
      429,
      `Upload limit reached: ${LIMITS.maxUploadsPerAccountPerDay} uploads per account per 24 hours.`,
    );
  if ((await residentBytes(db, caller.userId)) + input.size > LIMITS.maxResidentBytesPerAccount)
    throw new ReefError(
      413,
      "Account storage full: your files would exceed 10 GiB. Delete a file or wait for one to expire.",
    );
  if ((await residentBytes(db)) + input.size > LIMITS.maxResidentBytesService)
    throw new ReefError(413, "Reef is full right now. Try again in a few minutes.");

  const id = randomId();
  const multipart = input.size > ctx.partSize;
  const uploadId = multipart ? await ctx.storage.createMultipart(id, keyBytes) : null;
  const file: FileRow = {
    id,
    owner_id: caller.userId,
    name: input.name,
    size: input.size,
    state: "pending",
    r2_upload_id: uploadId,
    lifetime_minutes: lifetime,
    created_at: ctx.now,
    expires_at: null,
    download_limit: limit,
    download_count: 0,
  };
  await insertFile(
    db,
    file,
    shares.map((u) => u.id),
  );
  const origin = publicOrigin(ctx.env);
  const token = await issueToken(ctx.env.TOKEN_SIGNING_KEY, "up", id, caller.userId, ctx.now);
  const parts = multipart ? Math.ceil(input.size / ctx.partSize) : 1;
  logEvent("file.created", { file: id, user: caller.userId, size: input.size, parts });
  return {
    file,
    key,
    token,
    parts,
    command: multipart
      ? multipartScript(origin, token, key, input.name, input.size, ctx.partSize)
      : uploadCommand(origin, token, key, input.name),
    ...(multipart ? { python: multipartPython(origin, token, key, input.name, ctx.partSize) } : {}),
    // The clock starts when the upload finishes; this is the earliest possible expiry.
    handoff: handoffLine(id, key, input.name, ctx.now + lifetime * 60_000),
    shareWith: shares.map((u) => u.login),
  };
}

/** Loads a file the caller may see; "not found" covers both missing and not shared. */
async function accessibleFile(ctx: FilesContext, caller: Caller, fileId: string) {
  const file = /^[a-z0-9]{1,64}$/.test(fileId) ? await getFile(ctx.env.DB, fileId) : null;
  if (!file || !(await canAccess(ctx.env.DB, file, caller.userId)))
    throw new ReefError(404, `No file ${fileId} that you own or are shared on.`);
  return file;
}

/** Throws unless the file can be downloaded right now. */
export async function assertDownloadable(
  ctx: FilesContext,
  file: FileRow,
  checkLimit = true,
): Promise<number> {
  if (file.state === "pending") throw new ReefError(409, "The upload has not finished yet.");
  if (file.state === "deleted" || file.expires_at === null || file.expires_at <= ctx.now)
    throw new ReefError(410, "The file has expired or been deleted.");
  if (checkLimit && file.download_limit !== null && file.download_count >= file.download_limit)
    throw new ReefError(410, "The file's download limit is used up.");
  const owner = await getUser(ctx.env.DB, file.owner_id);
  if (!owner || owner.banned) throw new ReefError(410, "The file is no longer available.");
  return file.expires_at;
}

export interface DownloadGrant {
  file: FileRow;
  command: string;
  expiresAt: number;
  downloadsLeft: number | null;
}

export async function getDownload(
  ctx: FilesContext,
  caller: Caller,
  fileId: string,
): Promise<DownloadGrant> {
  const file = await accessibleFile(ctx, caller, fileId);
  const expiresAt = await assertDownloadable(ctx, file);
  const token = await issueToken(ctx.env.TOKEN_SIGNING_KEY, "dl", file.id, caller.userId, ctx.now);
  return {
    file,
    command: downloadCommand(publicOrigin(ctx.env), token, file.name),
    expiresAt,
    downloadsLeft: file.download_limit === null ? null : file.download_limit - file.download_count,
  };
}

export type ListedStatus = "uploading" | "ready" | "gone";

export interface ListedFileView {
  file: ListedFile;
  status: ListedStatus;
  minutesLeft: number | null;
  downloadsLeft: number | null;
  shares: string[];
}

/** "gone" covers expired, deleted and limit-reached-then-expired files alike. */
export function fileStatus(file: FileRow, now: number): ListedStatus {
  if (file.state === "pending") return "uploading";
  if (file.state === "ready" && file.expires_at !== null && file.expires_at > now) return "ready";
  return "gone";
}

export async function listFiles(ctx: FilesContext, caller: Caller): Promise<ListedFileView[]> {
  const rows = await listFilesFor(ctx.env.DB, caller.userId, ctx.now - ROW_RETENTION_MS);
  return Promise.all(
    rows.map(async (file) => {
      const status = fileStatus(file, ctx.now);
      return {
        file,
        status,
        minutesLeft:
          status === "ready" && file.expires_at !== null
            ? Math.ceil((file.expires_at - ctx.now) / 60_000)
            : null,
        downloadsLeft:
          file.download_limit === null
            ? null
            : Math.max(0, file.download_limit - file.download_count),
        shares: await shareLogins(ctx.env.DB, file.id),
      };
    }),
  );
}

export async function shareFile(
  ctx: FilesContext,
  caller: Caller,
  fileId: string,
  add: string[],
  remove: string[],
): Promise<{ file: FileRow; shares: string[] }> {
  const file = await accessibleFile(ctx, caller, fileId);
  if (file.owner_id !== caller.userId)
    throw new ReefError(403, "Only the file's owner can change its share list.");
  if (file.state === "deleted") throw new ReefError(410, "The file has expired or been deleted.");
  const db = ctx.env.DB;
  const toAdd = await resolveAccounts(
    db,
    uniqueLogins(add).filter((l) => l.toLowerCase() !== caller.login.toLowerCase()),
  );
  const toRemove = await findUsersByLogins(db, uniqueLogins(remove));
  const removeIds = new Set(toRemove.map((u) => u.id));
  const current = new Set(await shareUserIds(db, file.id));
  for (const id of removeIds) current.delete(id);
  for (const u of toAdd) current.add(u.id);
  if (current.size > LIMITS.maxShareList)
    throw new ReefError(400, `A share list holds at most ${LIMITS.maxShareList} accounts`);
  await setShares(
    db,
    file.id,
    toAdd.filter((u) => !removeIds.has(u.id)).map((u) => u.id),
    [...removeIds],
  );
  logEvent("file.shared", { file: file.id, user: caller.userId, shares: current.size });
  return { file, shares: await shareLogins(db, file.id) };
}

/** Removes the object (or aborts the multipart upload) and marks the row deleted. */
export async function destroyFile(ctx: FilesContext, file: FileRow): Promise<void> {
  if (file.state === "pending" && file.r2_upload_id)
    await ctx.storage.abortMultipart(file.id, file.r2_upload_id);
  await ctx.storage.delete([file.id]);
  await markDeleted(ctx.env.DB, [file.id], ctx.now);
  await removeParts(ctx.env.DB, file.id);
}

export async function deleteFile(
  ctx: FilesContext,
  caller: Caller,
  fileId: string,
): Promise<FileRow> {
  const file = await accessibleFile(ctx, caller, fileId);
  if (file.state === "deleted") throw new ReefError(410, "The file is already deleted.");
  await destroyFile(ctx, file);
  logEvent("file.deleted", { file: file.id, user: caller.userId });
  return file;
}
