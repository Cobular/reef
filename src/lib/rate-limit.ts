import { RATE_LIMITS } from "../config";
import { logError } from "./log";

export type LimitName = keyof typeof RATE_LIMITS;

/**
 * True if `key` (an IP or an account ID) is over the named limit. Fails open: a missing binding
 * (tests, local tools) or a failing one never blocks a request, because these are flood guards.
 */
export async function overLimit(env: Env, name: LimitName, key: string): Promise<boolean> {
  const binding: RateLimit | undefined = env[RATE_LIMITS[name].binding];
  if (!binding) return false;
  try {
    return !(await binding.limit({ key })).success;
  } catch (error) {
    logError("ratelimit.failed", error, { limit: name });
    return false;
  }
}

/** The caller's IP. Only Cloudflare's own header counts; it is absent only outside Cloudflare. */
export function clientIp(request: Request): string | null {
  return request.headers.get("CF-Connecting-IP");
}

/** What a refused caller sees, per limit. */
export const LIMIT_MESSAGES: Record<LimitName, string> = {
  ip: "Too many requests from your network.",
  bearer: "Too many requests from your network.",
  account: "Too many requests from this account.",
  auth: "Too many sign-in attempts from your network.",
  mcp: "Too many Reef requests from this account.",
  write: "Too many changes from this account.",
  data: "Too many uploads and downloads from this account.",
};

export function limitMessage(name: LimitName): string {
  return `${LIMIT_MESSAGES[name]} Wait ${RATE_LIMITS[name].period} seconds, then try again.`;
}
