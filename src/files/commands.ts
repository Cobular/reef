import { LIMITS } from "../config";

/** Quotes a value for POSIX shells: wraps it in single quotes and escapes embedded ones. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Control (Cc), format (Cf: bidi overrides, zero-width characters) and line/paragraph separator
 * (Zl, Zp) characters. Refused in names people choose, since they can break a line or reorder
 * how it reads. The zero-width joiner (U+200D) is allowed: it can't break or reorder text, and
 * emoji such as 👩‍💻 need it.
 */
export const HIDDEN_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]|(?!\u200D)\p{Cf}/u;

/**
 * A name chosen by another account, for tool output: a JSON string literal, with any
 * HIDDEN_CHARS escaped (JSON.stringify leaves Cf and U+2028/U+2029 as they are), so it can't
 * end the line or pass as Reef's own text.
 */
export function quoted(value: string): string {
  return JSON.stringify(value).replace(
    /[\p{Zl}\p{Zp}]|(?!\u200D)\p{Cf}/gu,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * File names are shown in commands, handoff lines, tool output and Content-Disposition, so they
 * must be a plain name: no path separators, no control, format or line-separator characters,
 * not `.` or `..`.
 */
export function fileNameProblem(name: string): string | null {
  if (name.length === 0) return "name must not be empty";
  if (name.length > LIMITS.maxFileNameLength)
    return `name must be at most ${LIMITS.maxFileNameLength} characters`;
  if (/[/\\]/.test(name)) return "name must be a file name, not a path (no / or \\)";
  if (HIDDEN_CHARS.test(name))
    return "name must not contain control, invisible formatting or line-separator characters";
  if (name === "." || name === "..") return "name must not be . or ..";
  if (name.trim() !== name) return "name must not start or end with whitespace";
  return null;
}

/** ISO 8601 UTC, to the second: 2026-01-02T03:04:05Z. */
export function utc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The handoff line. The name is a JSON string, and last but one, after id= and key=. */
export function handoffLine(fileId: string, key: string, name: string, expiresAt: number): string {
  return `Reef handoff: id=${fileId} key=${key} name=${quoted(name)} expires=${utc(expiresAt)}`;
}

export function uploadCommand(origin: string, token: string, key: string, name: string): string {
  return `curl -sS --fail-with-body -T ${shellQuote(name)} -H ${shellQuote(`X-Key: ${key}`)} ${shellQuote(
    `${origin}/up/${token}`,
  )}`;
}

/** Where a download lands: reef-<id>/<name>, with a leading dot replaced so it isn't hidden. */
export function downloadPath(fileId: string, name: string): string {
  return `reef-${fileId}/${name.replace(/^\./, "_")}`;
}

/**
 * The download command. The file goes into its own new directory, reef-<id>/, so a name the
 * sender chose can't overwrite or hide among the receiver's files.
 */
export function downloadCommand(
  origin: string,
  token: string,
  fileId: string,
  name: string,
): string {
  return `mkdir -p ${shellQuote(`reef-${fileId}`)} && curl -sSf -H 'X-Key: <key>' -o ${shellQuote(
    downloadPath(fileId, name),
  )} ${shellQuote(`${origin}/dl/${token}`)}`;
}

/**
 * The large-file script. Each part is cut to a temporary file first, so curl sends a real
 * Content-Length and can retry the part (it cannot rewind stdin, which `-T -` would need).
 */
export function multipartScript(
  origin: string,
  token: string,
  key: string,
  name: string,
  size: number,
  partSize: number,
): string {
  const parts = Math.ceil(size / partSize);
  const mib = partSize / 1048576;
  // Every part but the last is partSize bytes, so dd slices on whole MiB blocks.
  const blocks = Number.isInteger(mib)
    ? `bs=1048576 skip=$(( (i - 1) * ${mib} )) count=${mib}`
    : `bs=${partSize} skip=$(( i - 1 )) count=1`;
  // The parentheses run it in a subshell, so `exit` on failure does not close a pasted terminal.
  return [
    `(F=${shellQuote(name)}; KEY=${shellQuote(key)}; U=${shellQuote(`${origin}/up/${token}`)}`,
    `SIZE=${size}; N=${parts}`,
    `[ "$(wc -c < "$F" | tr -d ' ')" = "$SIZE" ] || { echo "$F is not $SIZE bytes" >&2; exit 1; }`,
    `T=$(mktemp) || exit 1; trap 'rm -f "$T"' EXIT`,
    "i=1",
    `while [ "$i" -le "$N" ]; do`,
    `  dd if="$F" of="$T" ${blocks} 2>/dev/null || exit 1`,
    `  curl -sS --fail-with-body --retry 3 -T "$T" -H "X-Key: $KEY" "$U/$i" || exit 1`,
    "  i=$((i + 1))",
    "done",
    `curl -sS --fail-with-body -X POST -H "X-Key: $KEY" "$U/complete")`,
  ].join("\n");
}

/** Python standard-library version of the large-file script, for machines without dd. */
export function multipartPython(
  origin: string,
  token: string,
  key: string,
  name: string,
  partSize: number,
): string {
  // JSON string literals are valid Python string literals.
  const lit = (value: string) => JSON.stringify(value);
  return [
    "python3 - <<'PY'",
    "import urllib.request",
    `F = ${lit(name)}; KEY = ${lit(key)}; U = ${lit(`${origin}/up/${token}`)}; P = ${partSize}`,
    "def send(url, data, method):",
    `    req = urllib.request.Request(url, data=data, method=method, headers={"X-Key": KEY})`,
    "    with urllib.request.urlopen(req) as r:",
    "        print(r.read().decode().strip())",
    `with open(F, "rb") as f:`,
    "    i = 1",
    "    while True:",
    "        chunk = f.read(P)",
    "        if not chunk:",
    "            break",
    `        send(f"{U}/{i}", chunk, "PUT")`,
    "        i += 1",
    `send(U + "/complete", b"", "POST")`,
    "PY",
  ].join("\n");
}
