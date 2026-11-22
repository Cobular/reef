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

/** School limits from DESIGN.md "Schools". */
export const SCHOOL_LIMITS = {
  maxGroupMembers: 20,
  maxSchoolNameLength: 100,
  /** Message text, measured in UTF-8 bytes. */
  maxMessageBytes: 8 * 1024,
  maxMessagesPerAccountPerMinute: 60,
  maxAttachments: 5,
  messageRetentionMs: 30 * 24 * 60 * 60 * 1000,
  /** Sessions not seen for this long are deleted, with their read positions. */
  sessionRetentionMs: 90 * 24 * 60 * 60 * 1000,
  defaultReadLimit: 50,
  maxReadLimit: 200,
  maxLabelLength: 100,
  maxProductLength: 64,
} as const;

/** Session types a session may declare in session_join (DESIGN.md "Session type"). */
export const SESSION_TYPES = ["chat", "local_coding", "hosted_coding", "persistent_agent"] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

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
/** One-time portal messages after a form post ("Invited unrealJune."). */
export const FLASH_COOKIE = "__Host-reef-flash";
export const FLASH_TTL_SECONDS = 60;

/** True if the GitHub login is listed in the ADMINS var (comma-separated, case-insensitive). */
export function isAdmin(env: Env, login: string): boolean {
  const admins = String(env.ADMINS ?? "")
    .split(",")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(login.toLowerCase());
}

export function publicOrigin(env: Env): string {
  let origin = env.PUBLIC_ORIGIN as string;
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  return origin;
}

export function signupMode(env: Env): "invite" | "open" {
  return (env.SIGNUP_MODE as string) === "open" ? "open" : "invite";
}
