import { base64UrlToBytes, bytesToBase64Url, utf8 } from "./base64";

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmacSign(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

/** Constant-time: WebCrypto's HMAC verify compares in constant time. */
export async function hmacVerify(
  secret: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const sig = base64UrlToBytes(signature);
  if (!sig) return false;
  if (sig.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig, utf8(message));
}

/** Constant-time string comparison for values such as OAuth `state`. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = utf8(a);
  const bb = utf8(b);
  if (ab.length !== bb.length) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(bytes = 32): string {
  return bytesToBase64Url(randomBytes(bytes));
}

// No 0/1/l/o, so IDs survive being read aloud or retyped.
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function randomId(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return out;
}

export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(text));
  return bytesToBase64Url(new Uint8Array(digest));
}
