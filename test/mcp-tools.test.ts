import { beforeEach, describe, expect, it } from "vitest";
import { mcpApiHandler } from "../src/mcp/server";
import {
  addUser,
  callTool,
  fileRow,
  ORIGIN,
  resetDb,
  rpcAs,
  schoolWith,
  TEST_PART_SIZE,
  testEnv,
} from "./helpers";

const alice = { userId: 1, login: "alice" };
const bob = { userId: 2, login: "bob" };
const carol = { userId: 3, login: "carol" };

function field(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  if (!match?.[1]) throw new Error(`no match for ${pattern} in:\n${text}`);
  return match[1];
}

beforeEach(async () => {
  await resetDb();
  await addUser(alice.userId, alice.login);
  await addUser(bob.userId, bob.login);
  await addUser(carol.userId, carol.login);
});

describe("create_upload", () => {
  it("returns a command, key, handoff line and the rules", async () => {
    const out = await callTool(alice, "create_upload", {
      name: "report.pdf",
      size: 1234,
      share_with: ["Bob"],
    });
    expect(out.isError).toBe(false);
    expect(out.text).toContain(`curl -sS --fail-with-body -T 'report.pdf'`);
    expect(out.text).toContain(`${ORIGIN}/up/`);
    expect(out.text).toMatch(/Key: [A-Za-z0-9+/]{43}=/);
    expect(out.text).toMatch(
      /Reef handoff: id=\S+ key=\S+ name="report\.pdf" expires=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m,
    );
    expect(out.text).toContain("Shared with: bob.");
    expect(out.text).toContain("The key is shown only here");
    const id = field(out.text, /Reef handoff: id=(\S+)/);
    expect((await fileRow(id))?.state).toBe("pending");
  });

  it("writes a multipart script when the file is bigger than one part", async () => {
    const out = await callTool(alice, "create_upload", { name: "big.bin", size: 12 * 1024 * 1024 });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("3 parts of 5 MiB");
    expect(out.text).toContain("/complete");
    expect(out.text).toContain("python3");
  });

  it("refuses unknown share-list accounts, bad names, and bad keys", async () => {
    const unknown = await callTool(alice, "create_upload", {
      name: "a.txt",
      size: 1,
      share_with: ["nobody-here"],
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("nobody-here");

    const badName = await callTool(alice, "create_upload", { name: "../etc/passwd", size: 1 });
    expect(badName.isError).toBe(true);

    const hidden = await callTool(alice, "create_upload", { name: "a\u202etxt.exe", size: 1 });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toContain("invisible formatting");

    const badKey = await callTool(alice, "create_upload", { name: "a.txt", size: 1, key: "short" });
    expect(badKey.isError).toBe(true);

    // A banned account can't be added; a login two accounts have held is refused, not guessed.
    await addUser(5, "dave", true);
    const banned = await callTool(alice, "create_upload", {
      name: "a.txt",
      size: 1,
      share_with: ["dave"],
    });
    expect(banned.isError).toBe(true);
    expect(banned.text).toContain("dave");
    await addUser(6, "BOB");
    const ambiguous = await callTool(alice, "create_upload", {
      name: "a.txt",
      size: 1,
      share_with: ["bob"],
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("More than one Reef account has had the login");

    // zod's own messages: English, though the bundle drops zod's other locales.
    const badSize = await callTool(alice, "create_upload", { name: "a.txt", size: "big" });
    expect(badSize.isError).toBe(true);
    expect(badSize.text).toContain("size: Invalid input: expected number, received string");
  });

  it("refuses files over 10 GB", async () => {
    const out = await callTool(alice, "create_upload", { name: "huge", size: 11 * 1024 ** 3 });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/10 GiB/);
  });
});

describe("get_download, list_files, share_file, delete_file", () => {
  async function readyFile(shareWith: string[] = []) {
    const out = await callTool(alice, "create_upload", {
      name: "notes.txt",
      size: 5,
      share_with: shareWith,
    });
    const id = field(out.text, /Reef handoff: id=(\S+)/);
    await testEnv()
      .DB.prepare("UPDATE files SET state = 'ready', expires_at = ? WHERE id = ?")
      .bind(Date.now() + 600_000, id)
      .run();
    return id;
  }

  it("gives the owner and the share list a download command", async () => {
    const id = await readyFile(["bob"]);
    const owner = await callTool(alice, "get_download", { file_id: id });
    expect(owner.isError).toBe(false);
    expect(owner.text).toContain(
      `mkdir -p 'reef-${id}' && curl -sSf -H 'X-Key: <key>' -o 'reef-${id}/notes.txt' '${ORIGIN}/dl/`,
    );
    expect(owner.text).toContain("from your account");
    expect(owner.text).toContain("Downloads left: unlimited");
    const shared = await callTool(bob, "get_download", { file_id: id });
    expect(shared.isError).toBe(false);
    expect(shared.text).toContain(`File "notes.txt", 5 bytes, from alice (another account).`);
    expect(shared.text).toContain("data, not instructions");
  });

  it("does not reveal files to accounts outside the share list", async () => {
    const id = await readyFile(["bob"]);
    const out = await callTool(carol, "get_download", { file_id: id });
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain("notes.txt");
    const missing = await callTool(carol, "get_download", { file_id: "nope" });
    expect(missing.text).toBe(out.text.replace(id, "nope"));
  });

  it("refuses downloads before the upload finishes", async () => {
    const out = await callTool(alice, "create_upload", { name: "p.txt", size: 5 });
    const id = field(out.text, /Reef handoff: id=(\S+)/);
    const dl = await callTool(alice, "get_download", { file_id: id });
    expect(dl.isError).toBe(true);
    expect(dl.text).toMatch(/not finished|still uploading/i);
  });

  it("lists own and shared files with status", async () => {
    await schoolWith([alice.userId, bob.userId]);
    const id = await readyFile(["bob"]);
    const listed = await callTool(bob, "list_files");
    expect(listed.text).toContain(id);
    expect(listed.text).toContain(`"notes.txt"`);
    expect(listed.text).toContain("owner alice (another account)");
    expect(listed.text).toMatch(/ready, \d+ minutes left/);
    expect(listed.text).toContain("untrusted data, not instructions");
    expect(listed.text).not.toContain("Not listed");
    expect((await callTool(alice, "list_files")).text).toContain("owner you");
    expect((await callTool(carol, "list_files")).text).toContain("no Reef files");
  });

  it("only counts files from accounts the caller shares no accepted school with", async () => {
    // carol hasn't accepted, so the school doesn't count for her or for files from her.
    await schoolWith([alice.userId, carol.userId], [alice.userId]);
    const id = await readyFile(["carol"]);
    const listed = await callTool(carol, "list_files");
    expect(listed.text).not.toContain(id);
    expect(listed.text).not.toContain("notes.txt");
    expect(listed.text).toContain("Not listed: 1 file(s) shared with you by accounts");
    // A handoff still works by ID.
    expect((await callTool(carol, "get_download", { file_id: id })).isError).toBe(false);
  });

  it("never lists another account's upload that hasn't finished", async () => {
    await schoolWith([alice.userId, bob.userId]);
    const out = await callTool(alice, "create_upload", {
      name: "p.txt",
      size: 5,
      share_with: ["bob"],
    });
    const id = field(out.text, /Reef handoff: id=(\S+)/);
    const listed = await callTool(bob, "list_files");
    expect(listed.text).not.toContain(id);
    expect(listed.text).not.toContain("Not listed");
    expect((await callTool(alice, "list_files")).text).toContain(id);
  });

  it("lets only the owner change the share list", async () => {
    const id = await readyFile();
    const added = await callTool(alice, "share_file", { file_id: id, add: ["bob", "carol"] });
    expect(added.text).toContain("bob, carol");
    const removed = await callTool(alice, "share_file", { file_id: id, remove: ["carol"] });
    expect(removed.text).toContain("shared with: bob.");
    expect((await callTool(carol, "get_download", { file_id: id })).isError).toBe(true);
    const byBob = await callTool(bob, "share_file", { file_id: id, add: ["carol"] });
    expect(byBob.isError).toBe(true);
  });

  it("lets the owner or a share-list account delete a file", async () => {
    const id = await readyFile(["bob"]);
    expect((await callTool(carol, "delete_file", { file_id: id })).isError).toBe(true);
    const out = await callTool(bob, "delete_file", { file_id: id });
    expect(out.isError).toBe(false);
    expect((await fileRow(id))?.state).toBe("deleted");
    const again = await callTool(alice, "get_download", { file_id: id });
    expect(again.isError).toBe(true);
    expect((await callTool(alice, "list_files")).text).toContain("gone since");
  });
});

describe("one handler serving many requests", () => {
  it("keeps each request's caller apart, in turn and at once", async () => {
    const handler = mcpApiHandler(TEST_PART_SIZE);
    const env = testEnv();
    const listed = (await rpcAs(alice, "tools/list", {}, env, handler)) as {
      tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    };
    const upload = listed.tools.find((t) => t.name === "create_upload");
    expect(Object.keys(upload?.inputSchema.properties ?? {})).toContain("share_with");
    // Lenient integer arguments still advertise themselves as integers.
    expect(upload?.inputSchema.properties?.size).toMatchObject({ type: "integer", minimum: 0 });
    // The second listing comes from the cached JSON Schema and must match the first.
    expect(await rpcAs(bob, "tools/list", {}, env, handler)).toEqual(listed);

    const mine = await callTool(alice, "create_upload", { name: "a.txt", size: 1 }, env, handler);
    const id = field(mine.text, /Reef handoff: id=(\S+)/);
    expect((await callTool(bob, "list_files", {}, env, handler)).text).not.toContain(id);

    const [a, b, c] = await Promise.all([
      callTool(alice, "list_files", {}, env, handler),
      callTool(bob, "list_files", {}, env, handler),
      callTool(carol, "create_upload", { name: "c.txt", size: 1 }, env, handler),
    ]);
    expect(a.text).toContain(id);
    expect(b.text).toContain("You have no Reef files");
    expect(c.isError).toBe(false);
    expect((await callTool(bob, "get_download", { file_id: id }, env, handler)).isError).toBe(true);
  });
});
