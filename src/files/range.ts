export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * Parses a single-range `Range: bytes=…` header against an object of `size` bytes.
 * Returns null when there is no usable Range (serve the whole file, as RFC 9110 allows for
 * multi-range or malformed headers), or "unsatisfiable" for a 416.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText = "", endText = ""] = match;
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(startText);
  if (start >= size) return "unsatisfiable";
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}
