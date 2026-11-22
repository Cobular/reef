/** Service limits from DESIGN.md "Limits". Sizes use binary units (GB = GiB). */

const GiB = 1024 ** 3;

export const LIMITS = {
  maxFileBytes: 10 * GiB,
  maxResidentBytesPerAccount: 10 * GiB,
  maxResidentBytesService: 30 * GiB,
  maxUploadsPerAccountPerDay: 50,
  maxShareList: 10,
  defaultLifetimeMinutes: 10,
  maxLifetimeMinutes: 30,
  maxFileNameLength: 255,
} as const;

/** 90 MiB: the single-PUT ceiling and the multipart part size. */
export const PART_SIZE = 94_371_840;

/** R2 multipart uploads allow at most 10,000 parts; 10 GiB / 90 MiB is 114, well inside. */
export const MAX_PARTS = 10_000;

export const UPLOAD_TOKEN_TTL_MS = 30 * 60 * 1000;
export const DOWNLOAD_TOKEN_TTL_MS = 60 * 1000;

/** Rows stay this long after expiry so recently expired files can still be listed. */
export const ROW_RETENTION_MS = 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "__Host-reef-session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const PORTAL_STATE_COOKIE = "__Host-reef-login";
export const STATE_TTL_SECONDS = 10 * 60;

export function publicOrigin(env: Env): string {
  let origin = env.PUBLIC_ORIGIN as string;
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  return origin;
}

export function signupMode(env: Env): "invite" | "open" {
  return (env.SIGNUP_MODE as string) === "open" ? "open" : "invite";
}
