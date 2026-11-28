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
  fileWithShares,
  findUsersByNames,
  getFile,
  getUser,
  insertFile,
  type ListedFile,
  listFilesFor,
  markDeleted,
  deleteParts as removeParts,
  residentBytes,
  serviceResidentBytes,
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
    /** Seconds, sent as Retry-After where the refusal is an HTTP response. */
    readonly retryAfter?: number,
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

/** Account names as typed (GitHub logins or display names), trimmed, without a leading @. */
export function uniqueLogins(logins: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of logins) {
    const login = raw.trim().replace(/^@/, "");
    if (login && !seen.has(login.toLowerCase())) seen.set(login.toLowerCase(), login);
  }
  return [...seen.values()];
}

/**
 * Resolves account names (GitHub logins or display names) to accounts other than the caller;
 * refuses any that are not existing, active accounts. Each account appears once.
 */
async function resolveAccounts(db: D1Database, caller: Caller, names: string[]) {
  const found = await findUsersByNames(db, names);
  const missing = names.filter((n) => {
    const user = found.get(n.toLowerCase());
    return user?.banned !== 0;
  });
  if (missing.length > 0) {
    throw new ReefError(
      400,
      `Not Reef accounts: ${missing.join(", ")}. Share lists only accept people who have signed in to Reef.`,
    );
  }
  const byId = new Map([...found.values()].map((u) => [u.id, u]));
  byId.delete(caller.userId);
  return [...byId.values()];
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

  const names = uniqueLogins(input.share_with ?? []);
  const shares = await resolveAccounts(db, caller, names);
  if (shares.length > LIMITS.maxShareList)
    throw new ReefError(400, `A share list holds at most ${LIMITS.maxShareList} accounts`);

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
  if ((await serviceResidentBytes(db)) + input.size > LIMITS.maxResidentBytesService)
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
    shareWith: shares.map((u) => u.display_name ?? u.login),
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

export interface Account {
  id: number;
  /** The shown name: the display name if the account chose one, else its GitHub login. */
  login: string;
  /** True when the account chose a display name, so its GitHub avatar is not shown. */
  aliased?: boolean;
}

export interface ListedFileView {
  file: ListedFile;
  status: ListedStatus;
  minutesLeft: number | null;
  downloadsLeft: number | null;
  shares: string[];
  /** The share list with account IDs (for avatars), in the same order as `shares`. */
  shareAccounts: Account[];
}

/** "gone" covers expired, deleted and limit-reached-then-expired files alike. */
export function fileStatus(file: FileRow, now: number): ListedStatus {
  if (file.state === "pending") return "uploading";
  if (file.state === "ready" && file.expires_at !== null && file.expires_at > now) return "ready";
  return "gone";
}

function fileView(file: ListedFile, accounts: Account[], now: number): ListedFileView {
  const status = fileStatus(file, now);
  return {
    file,
    status,
    minutesLeft:
      status === "ready" && file.expires_at !== null
        ? Math.ceil((file.expires_at - now) / 60_000)
        : null,
    downloadsLeft:
      file.download_limit === null ? null : Math.max(0, file.download_limit - file.download_count),
    shares: accounts.map((a) => a.login),
    shareAccounts: accounts,
  };
}

export async function listFiles(ctx: FilesContext, caller: Caller): Promise<ListedFileView[]> {
  const { files, shares } = await listFilesFor(
    ctx.env.DB,
    caller.userId,
    ctx.now - ROW_RETENTION_MS,
  );
  const byFile = new Map<string, Account[]>();
  for (const s of shares) {
    const list = byFile.get(s.file_id) ?? [];
    list.push({ id: s.user_id, login: s.login, aliased: s.aliased === 1 });
    byFile.set(s.file_id, list);
  }
  return files.map((file) => fileView(file, byFile.get(file.id) ?? [], ctx.now));
}

/**
 * One file the caller owns or is shared on, with its share list, in one round trip. A missing
 * file and one the caller may not see get the same 404.
 */
export async function fileDetails(
  ctx: FilesContext,
  caller: Caller,
  fileId: string,
): Promise<ListedFileView> {
  const found = /^[a-z0-9]{1,64}$/.test(fileId)
    ? await fileWithShares(ctx.env.DB, fileId)
    : { file: null, shares: [] };
  const { file, shares } = found;
  if (
    !file ||
    (file.owner_id !== caller.userId && !shares.some((s) => s.user_id === caller.userId))
  )
    throw new ReefError(404, `No file ${fileId} that you own or are shared on.`);
  return fileView(
    file,
    shares.map((s) => ({ id: s.user_id, login: s.login, aliased: s.aliased === 1 })),
    ctx.now,
  );
}

/** Loads a file for a signed-in download; the bytes then go out through `streamDownload`. */
export function downloadableFile(
  ctx: FilesContext,
  caller: Caller,
  fileId: string,
): Promise<FileRow> {
  return accessibleFile(ctx, caller, fileId);
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
  const toAdd = await resolveAccounts(db, caller, uniqueLogins(add));
  const toRemove = await findUsersByNames(db, uniqueLogins(remove));
  const removeIds = new Set([...toRemove.values()].map((u) => u.id));
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
