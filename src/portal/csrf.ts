import { publicOrigin } from "../config";
import { hmacSign, timingSafeEqualStrings } from "../lib/crypto";

/**
 * The form token for one portal session: HMAC(COOKIE_SECRET, "csrf:" + userId + ":" + iat), 32
 * base64url chars. Bound to the session's issue time, so a token seen once stops working when
 * that session ends.
 */
export async function csrfToken(env: Env, userId: number, iat: number): Promise<string> {
  return (await hmacSign(env.COOKIE_SECRET, `csrf:${userId}:${iat}`)).slice(0, 32);
}

/**
 * A portal POST passes when its `csrf` field matches the account's token (constant time) and
 * its `Origin` header, if any, is Reef's own.
 */
export function csrfOk(
  request: Request,
  env: Env,
  expected: string | null,
  submitted: string | null,
): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== publicOrigin(env)) return false;
  if (!expected || !submitted) return false;
  return timingSafeEqualStrings(expected, submitted);
}
