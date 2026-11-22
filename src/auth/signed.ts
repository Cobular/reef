import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from "../lib/base64";
import { hmacSign, hmacVerify } from "../lib/crypto";

/**
 * Small signed values for cookies: base64url(JSON) "." base64url(HMAC-SHA256(COOKIE_SECRET)).
 * `purpose` is signed in, so a value minted for one cookie is never accepted as another.
 */
export async function signValue(
  secret: string,
  purpose: string,
  data: Record<string, unknown>,
  expiresAt: number,
): Promise<string> {
  const body = bytesToBase64Url(utf8(JSON.stringify({ ...data, p: purpose, exp: expiresAt })));
  return `${body}.${await hmacSign(secret, body)}`;
}

export async function verifyValue(
  secret: string,
  purpose: string,
  value: string | null,
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
  if (!value || value.length > 4096) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  if (!(await hmacVerify(secret, body, value.slice(dot + 1)))) return null;
  const bytes = base64UrlToBytes(body);
  if (!bytes) return null;
  try {
    const data = JSON.parse(fromUtf8(bytes)) as Record<string, unknown>;
    if (data.p !== purpose || typeof data.exp !== "number" || now >= data.exp) return null;
    return data;
  } catch {
    return null;
  }
}
