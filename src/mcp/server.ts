import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { RATE_LIMITS } from "../config";
import { utc } from "../files/commands";
import { getUser } from "../files/repo";
import {
  type Caller,
  createUpload,
  deleteFile,
  filesContext,
  getDownload,
  listFiles,
  ReefError,
  shareFile,
} from "../files/service";
import { mcpRefusal } from "../guard";
import { limitMessage, overLimit } from "../lib/rate-limit";
import {
  bullets,
  CREATE_UPLOAD_DESCRIPTION,
  CREATE_UPLOAD_RULES,
  DELETE_FILE_DESCRIPTION,
  GET_DOWNLOAD_DESCRIPTION,
  GET_DOWNLOAD_RULES,
  LIST_FILES_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  SHARE_FILE_DESCRIPTION,
} from "./guidance";
import { run } from "./result";
import { lenientInt, memoJsonSchema } from "./schema";
import { registerSchoolTools } from "./schools";

/** Props stored in the OAuth grant by completeAuthorization (see auth-mcp.ts). */
export interface McpProps {
  userId: number;
  login: string;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]} (${bytes} bytes)`;
}

const fileId = z.string().min(1).max(64).describe("The file ID, as in a handoff line's id= field.");
const logins = z.array(z.string().min(1).max(39)).max(10);

// Schemas are built, and converted to JSON Schema, once per isolate rather than per request.
const createUploadInput = memoJsonSchema(
  z.object({
    name: z.string().min(1).max(255).describe("File name, without a directory, e.g. report.pdf"),
    size: lenientInt(z.number().int().min(0)).describe(
      "Exact file size in bytes, e.g. from `wc -c < file`",
    ),
    lifetime_minutes: lenientInt(z.number().int().min(1).max(30))
      .optional()
      .describe("Minutes the file lives after the upload finishes. Default 10, at most 30."),
    download_limit: lenientInt(z.number().int().min(1))
      .optional()
      .describe("How many downloads may start. Omit for no limit."),
    share_with: logins
      .optional()
      .describe("Reef accounts that may download it, by GitHub login or display name, at most 10."),
    key: z
      .string()
      .optional()
      .describe("Your own 32-byte base64 key. Omit and Reef generates one (recommended)."),
  }),
);
const fileInput = memoJsonSchema(z.object({ file_id: fileId }));
const noInput = memoJsonSchema(z.object({}));
const shareInput = memoJsonSchema(
  z.object({
    file_id: fileId,
    add: logins.optional().describe("Accounts to add, by GitHub login or display name."),
    remove: logins.optional().describe("Accounts to remove, by GitHub login or display name."),
  }),
);

/**
 * One request's MCP server. The SDK needs a new instance per request (it refuses to reuse one
 * that is serving, and keeps each exchange's negotiated client state on it), and the closures
 * below capture this request's caller; the schemas and their JSON Schema are shared.
 */
export function buildServer(env: Env, caller: Caller, partSize: number): McpServer {
  const server = new McpServer(
    { name: "reef", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const ctx = () => filesContext(env, partSize);

  server.registerTool(
    "create_upload",
    {
      title: "Create upload",
      description: CREATE_UPLOAD_DESCRIPTION,
      inputSchema: createUploadInput,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    (input) =>
      run("create_upload", async () => {
        if (await overLimit(env, "write", String(caller.userId)))
          throw new ReefError(429, limitMessage("write"), RATE_LIMITS.write.period);
        const c = ctx();
        const up = await createUpload(c, caller, input);
        const lines = [
          `File ${up.file.id} is ready to receive ${up.file.name}, ${sizeText(up.file.size)}.`,
          `Lifetime: ${up.file.lifetime_minutes} minutes after the upload finishes.`,
          `Download limit: ${up.file.download_limit ?? "none"}.`,
          `Shared with: ${up.shareWith.length > 0 ? up.shareWith.join(", ") : "nobody else yet (use share_file)"}.`,
          "",
          up.parts > 1
            ? `Upload script (${up.parts} parts of ${partSize / 1024 / 1024} MiB; run it in the directory holding the file):`
            : "Upload command (run it in the directory holding the file):",
          up.command,
        ];
        if (up.python) {
          lines.push("", "If dd is unavailable, this Python version does the same:", up.python);
        }
        lines.push(
          "",
          "The upload link works for 30 minutes. When it finishes it prints the exact expiry time.",
          "",
          `Key: ${up.key}`,
          "",
          "Handoff line (expires= assumes the upload finishes now; it ends later if the upload takes longer):",
          up.handoff,
          "",
          "Rules:",
          bullets(CREATE_UPLOAD_RULES),
        );
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "get_download",
    {
      title: "Get download",
      description: GET_DOWNLOAD_DESCRIPTION,
      inputSchema: fileInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ file_id }) =>
      run("get_download", async () => {
        const c = ctx();
        const grant = await getDownload(c, caller, file_id);
        const minutes = Math.max(0, Math.ceil((grant.expiresAt - c.now) / 60_000));
        return [
          `${grant.file.name}, ${sizeText(grant.file.size)}.`,
          `Expires ${utc(grant.expiresAt)} (about ${minutes} minutes left).`,
          `Downloads left: ${grant.downloadsLeft ?? "unlimited"}.`,
          "",
          "Download command:",
          grant.command,
          "",
          "Rules:",
          bullets(GET_DOWNLOAD_RULES),
        ].join("\n");
      }),
  );

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: LIST_FILES_DESCRIPTION,
      inputSchema: noInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run("list_files", async () => {
        const c = ctx();
        const files = await listFiles(c, caller);
        if (files.length === 0)
          return "You have no Reef files, and none expired in the last 24 hours.";
        const lines = files.map((f) => {
          const parts = [
            `${f.file.id}  ${f.file.name}  ${sizeText(f.file.size)}`,
            `owner ${f.file.owner_login}`,
          ];
          if (f.status === "ready") parts.push(`ready, ${f.minutesLeft} minutes left`);
          else if (f.status === "uploading") parts.push("upload not finished");
          else parts.push(`gone since ${utc(f.file.expires_at ?? f.file.created_at)}`);
          if (f.status !== "gone") parts.push(`downloads left: ${f.downloadsLeft ?? "unlimited"}`);
          parts.push(`shared with: ${f.shares.length > 0 ? f.shares.join(", ") : "nobody"}`);
          return `- ${parts.join("; ")}`;
        });
        return [`${files.length} file(s):`, ...lines].join("\n");
      }),
  );

  server.registerTool(
    "share_file",
    {
      title: "Share file",
      description: SHARE_FILE_DESCRIPTION,
      inputSchema: shareInput,
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    ({ file_id, add, remove }) =>
      run("share_file", async () => {
        const result = await shareFile(ctx(), caller, file_id, add ?? [], remove ?? []);
        return result.shares.length > 0
          ? `${result.file.name} (${result.file.id}) is shared with: ${result.shares.join(", ")}.`
          : `${result.file.name} (${result.file.id}) is shared with nobody else.`;
      }),
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete file",
      description: DELETE_FILE_DESCRIPTION,
      inputSchema: fileInput,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ file_id }) =>
      run("delete_file", async () => {
        const file = await deleteFile(ctx(), caller, file_id);
        return `Deleted ${file.name} (${file.id}). Nobody can download it now.`;
      }),
  );

  registerSchoolTools(server, env, caller);

  return server;
}

/**
 * The OAuth provider's apiHandler for /mcp. The provider has already validated the bearer
 * token and put the grant's props in ctx.props; this refuses banned accounts and serves a fresh,
 * stateless MCP server for the request (no Durable Objects needed).
 */
export function mcpApiHandler(partSize: number) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const props = ctx.props as Partial<McpProps> | undefined;
      if (typeof props?.userId !== "number" || typeof props.login !== "string") {
        return new Response("Unauthorized", { status: 401 });
      }
      // Before the D1 lookup; a rate-limited tool call still gets a readable tool error.
      if (await overLimit(env, "mcp", String(props.userId)))
        return mcpRefusal(request, 429, limitMessage("mcp"), {
          "Retry-After": String(RATE_LIMITS.mcp.period),
        });
      const user = await getUser(env.DB, props.userId);
      if (!user || user.banned) {
        return Response.json({ error: "account_suspended" }, { status: 403 });
      }
      const caller: Caller = { userId: user.id, login: user.login };
      const handler = createMcpHandler(() => buildServer(env, caller, partSize), { route: "/mcp" });
      return handler(request, env, ctx);
    },
  };
}
