import { z } from "zod";

type JsonSchemaOptions = Parameters<z.ZodType["~standard"]["jsonSchema"]["input"]>[0];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Makes a module-level schema convert to JSON Schema once per isolate. The MCP SDK converts each
 * tool's input schema on every tools/list, and on every tools/call through a cache that lives on
 * the server instance; Reef builds a fresh server per request, so that cache never hits. Zod's
 * validation is untouched. The cached JSON is frozen because every request shares it.
 */
export function memoJsonSchema<T extends z.ZodType>(schema: T): T {
  const standard = schema["~standard"];
  const cache = new Map<string, Record<string, unknown>>();
  const memo =
    (io: "input" | "output") =>
    (options: JsonSchemaOptions): Record<string, unknown> => {
      if (options.libraryOptions) return standard.jsonSchema[io](options);
      const key = `${io} ${options.target}`;
      let json = cache.get(key);
      if (!json) {
        json = deepFreeze(standard.jsonSchema[io](options));
        cache.set(key, json);
      }
      return json;
    };
  schema["~standard"] = {
    ...standard,
    jsonSchema: { input: memo("input"), output: memo("output") },
  };
  return schema;
}

/**
 * A whole-number tool argument that also accepts a string of digits. Clients that cached an
 * older tool list (claude.ai keeps one until the connector is refreshed) send arguments they
 * don't know the type of as strings, so `"20"` arrives for a new integer field. The advertised
 * JSON Schema stays `integer`; empty strings, null and other text are still refused.
 */
export function lenientInt<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value),
    schema,
  );
}
