/**
 * Logging policy (DESIGN.md, "What the operator can see"):
 * - never log request headers, request bodies, file keys, tokens, cookies or secrets;
 * - log one JSON object per line, built only from an event name and primitive fields;
 * - field names that look sensitive are dropped, not masked, so nothing leaks by accident.
 */

type Field = string | number | boolean | null | undefined;

const FORBIDDEN_FIELD = /key|token|secret|cookie|header|body|authorization|password|state|code/i;

export function sanitize(fields: Record<string, Field>): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (FORBIDDEN_FIELD.test(name)) continue;
    if (value === undefined) continue;
    out[name] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  return out;
}

export function logEvent(event: string, fields: Record<string, Field> = {}): void {
  console.log(JSON.stringify({ event, ...sanitize(fields) }));
}

/** Logs an error by type and message only. Never pass a request or response here. */
export function logError(event: string, error: unknown, fields: Record<string, Field> = {}): void {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(
    JSON.stringify({
      event,
      level: "error",
      error: err.name,
      message: err.message.slice(0, 200),
      ...sanitize(fields),
    }),
  );
}
