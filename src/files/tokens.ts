import { DOWNLOAD_TOKEN_TTL_MS, UPLOAD_TOKEN_TTL_MS } from "../config";
import { base64UrlToBytes, bytesToBase64Url, fromUtf8, utf8 } from "../lib/base64";
import { hmacSign, hmacVerify } from "../lib/crypto";

export type TokenAction = "up" | "dl";

export interface TokenClaims {
  fileId: string;
  action: TokenAction;
  /** Account the token was issued to; rechecked (ban, share list) on use. */
  userId: number;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

interface Wire {
  f: string;
  a: TokenAction;
  u: number;
  e: number;
}

/**
 * Token format: base64url(JSON claims) "." base64url(HMAC-SHA256(TOKEN_SIGNING_KEY, first part)).
 * Stateless: no token table. A token names one file and one action and cannot decrypt anything.
 */
export async function signToken(secret: string, claims: TokenClaims): Promise<string> {
  const wire: Wire = { f: claims.fileId, a: claims.action, u: claims.userId, e: claims.expiresAt };
  const body = bytesToBase64Url(utf8(JSON.stringify(wire)));
  return `${body}.${await hmacSign(secret, body)}`;
}

export function issueToken(
  secret: string,
  action: TokenAction,
  fileId: string,
  userId: number,
  now = Date.now(),
): Promise<string> {
  const ttl = action === "up" ? UPLOAD_TOKEN_TTL_MS : DOWNLOAD_TOKEN_TTL_MS;
  return signToken(secret, { fileId, action, userId, expiresAt: now + ttl });
}

/** Returns the claims if the signature is valid, the action matches and it has not expired. */
export async function verifyToken(
  secret: string,
  token: string,
  action: TokenAction,
  now = Date.now(),
): Promise<TokenClaims | null> {
  if (token.length > 512) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  if (!(await hmacVerify(secret, body, token.slice(dot + 1)))) return null;
  const bytes = base64UrlToBytes(body);
  if (!bytes) return null;
  let wire: Partial<Wire>;
  try {
    wire = JSON.parse(fromUtf8(bytes)) as Partial<Wire>;
  } catch {
    return null;
  }
  if (
    typeof wire.f !== "string" ||
    typeof wire.u !== "number" ||
    typeof wire.e !== "number" ||
    wire.a !== action
  ) {
    return null;
  }
  if (now >= wire.e) return null;
  return { fileId: wire.f, action: wire.a, userId: wire.u, expiresAt: wire.e };
}
