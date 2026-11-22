import { ReefError } from "../files/service";
import { logError } from "../lib/log";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Runs a tool body, turning refusals into tool errors the session can read and act on. */
export async function run(tool: string, body: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await body());
  } catch (error) {
    if (error instanceof ReefError)
      return { content: [{ type: "text", text: error.message }], isError: true };
    logError("mcp.tool_error", error, { tool });
    return {
      content: [{ type: "text", text: "Reef hit an internal error. Try again." }],
      isError: true,
    };
  }
}
