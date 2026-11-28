import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { changeDisplayName } from "../src/account/service";
import { admit } from "../src/auth/signup";
import { getUser } from "../src/files/repo";
import { createUpload, filesContext, listFiles, shareFile } from "../src/files/service";
import {
  acceptInvite,
  createSchool,
  inviteToSchool,
  joinSession,
  listSchoolsFor,
  readMessages,
  schoolsContext,
  sendMessage,
} from "../src/schools/service";
import { addUser, callTool, invite, resetDb, TEST_PART_SIZE, testEnv } from "./helpers";

const alice = { userId: 1, login: "alice" };
const bob = { userId: 2, login: "bob" };
const carol = { userId: 3, login: "carol" };

const ctx = () => schoolsContext(testEnv());
const files = () => filesContext(testEnv(), TEST_PART_SIZE);

beforeEach(async () => {
  await resetDb();
  await addUser(alice.userId, alice.login);
  await addUser(bob.userId, bob.login);
  await addUser(carol.userId, carol.login);
});

describe("choosing a display name", () => {
  it("sets, changes and clears a name, refusing bad shapes", async () => {
    expect(await changeDisplayName(env.DB, bob.userId, "  @Reef-Bob ")).toEqual({
      ok: true,
      name: "Reef-Bob",
    });
    expect((await getUser(env.DB, bob.userId))?.display_name).toBe("Reef-Bob");
    for (const bad of ["two words", "-dash", "dot.", "a(b", "x".repeat(40), "your user"])
      expect((await changeDisplayName(env.DB, bob.userId, bad)).ok).toBe(false);
    expect((await getUser(env.DB, bob.userId))?.display_name).toBe("Reef-Bob");
    expect(await changeDisplayName(env.DB, bob.userId, "")).toEqual({ ok: true, name: null });
    expect((await getUser(env.DB, bob.userId))?.display_name).toBeNull();
  });

  it("refuses another account's login or display name, in any case", async () => {
    expect(await changeDisplayName(env.DB, bob.userId, "ALICE")).toEqual({
      ok: false,
      error: "That name is taken by another Reef account. Choose another.",
    });
    expect((await changeDisplayName(env.DB, bob.userId, "fin")).ok).toBe(true);
    expect((await changeDisplayName(env.DB, carol.userId, "Fin")).ok).toBe(false);
    // An account may take its own login, or keep the name it has.
    expect((await changeDisplayName(env.DB, carol.userId, "Carol")).ok).toBe(true);
    expect((await changeDisplayName(env.DB, bob.userId, "fin")).ok).toBe(true);
  });

  it("gives way to a GitHub login that arrives later", async () => {
    expect((await changeDisplayName(env.DB, bob.userId, "dana")).ok).toBe(true);
    await invite("dana");
    const admitted = await admit(testEnv(), { id: 4, login: "dana" });
    expect(admitted.ok).toBe(true);
    expect((await getUser(env.DB, bob.userId))?.display_name).toBeNull();

    // A renamed login takes precedence too.
    expect((await changeDisplayName(env.DB, bob.userId, "erin")).ok).toBe(true);
    await admit(testEnv(), { id: carol.userId, login: "erin" });
    expect((await getUser(env.DB, bob.userId))?.display_name).toBeNull();
  });
});

describe("showing and accepting display names", () => {
  it("shows the name in envelopes, member lists and invites, and accepts it to invite", async () => {
    await changeDisplayName(env.DB, bob.userId, "reef-bob");
    const made = await createSchool(ctx(), alice.userId, "team", "group", ["reef-bob"]);
    expect(made.invited).toEqual(["reef-bob"]);
    const id = made.school.id;
    await acceptInvite(ctx(), bob.userId, id);
    expect((await inviteToSchool(ctx(), bob.userId, id, ["carol"])).invited).toEqual(["carol"]);

    const listed = (await listSchoolsFor(ctx(), alice.userId))[0];
    expect(listed?.members.find((m) => m.id === bob.userId)).toMatchObject({
      login: "reef-bob",
      aliased: true,
    });

    const hb = (await joinSession(ctx(), bob.userId, "chat", "web", "claude-ai")).handle;
    await sendMessage(ctx(), bob.userId, hb, id, "hello");
    const ha = (await joinSession(ctx(), alice.userId, "chat", "web", "claude-ai")).handle;
    const read = await callTool(alice, "school_read", { handle: ha, school: id });
    expect(read.text).toContain("From: reef-bob (another account) | session type chat");
    expect(read.text).not.toMatch(/(^|[^-])bob/m);
    const list = await callTool(alice, "school_list");
    expect(list.text).toContain("members: alice, carol (invited), reef-bob");

    const own = await readMessages(ctx(), bob.userId, hb, id);
    expect(own.messages).toEqual([]);
  });

  it("accepts the name on share lists and shows it there", async () => {
    await changeDisplayName(env.DB, bob.userId, "reef-bob");
    const up = await createUpload(files(), alice, {
      name: "a.txt",
      size: 1,
      share_with: ["Reef-Bob", "alice"],
    });
    expect(up.shareWith).toEqual(["reef-bob"]);
    const [view] = await listFiles(files(), alice);
    expect(view?.shares).toEqual(["reef-bob"]);
    expect(view?.shareAccounts[0]?.aliased).toBe(true);

    const shared = await shareFile(files(), alice, up.file.id, ["carol"], ["reef-bob"]);
    expect(shared.shares).toEqual(["carol"]);
    // Bob's GitHub login still works as a name.
    expect((await shareFile(files(), alice, up.file.id, ["bob"], [])).shares).toEqual([
      "carol",
      "reef-bob",
    ]);
    const mine = await listFiles(files(), bob);
    expect(mine[0]?.file.owner_login).toBe("alice");
  });
});
