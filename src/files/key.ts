import { base64ToBytes, bytesToBase64 } from "../lib/base64";
import { randomBytes } from "../lib/crypto";

export const KEY_BYTES = 32;

/** A file key: 32 bytes, standard base64. Reef never stores it. */
export function generateKey(): string {
  return bytesToBase64(randomBytes(KEY_BYTES));
}

/** Parses a base64 key; returns the raw bytes or null unless it is exactly 32 bytes. */
export function parseKey(value: string | null | undefined): ArrayBuffer | null {
  if (!value) return null;
  const bytes = base64ToBytes(value.trim());
  if (!bytes || bytes.length !== KEY_BYTES) return null;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function isValidKey(value: string): boolean {
  return parseKey(value) !== null;
}
