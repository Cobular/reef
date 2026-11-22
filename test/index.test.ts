import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { createUpload, filesContext } from "../src/files/service";
import { issueToken } from "../src/files/tokens";
import { addUser, resetDb } from "./helpers";

it("responds", async () => {
  const res = await SELF.fetch("https://reef.cobular.com/");
  expect(res.status).toBe(200);
});

it("uploads and downloads through the deployed entry point", async () => {
  await resetDb();
  await addUser(1, "alice");
  const up = await createUpload(
    filesContext(env, 94_371_840),
    { userId: 1, login: "alice" },
    {
      name: "hello.txt",
      size: 5,
    },
  );
  const put = await SELF.fetch(`https://reef.cobular.com/up/${up.token}`, {
    method: "PUT",
    headers: { "X-Key": up.key },
    body: "hello",
  });
  expect(put.status, await put.clone().text()).toBe(200);
  const token = await issueToken(env.TOKEN_SIGNING_KEY, "dl", up.file.id, 1, Date.now());
  const get = await SELF.fetch(`https://reef.cobular.com/dl/${token}`, {
    headers: { "X-Key": up.key },
  });
  expect(get.status).toBe(200);
  expect(await get.text()).toBe("hello");
  // Keys in the query string are never read.
  const query = await SELF.fetch(
    `https://reef.cobular.com/dl/${token}?key=${encodeURIComponent(up.key)}`,
  );
  expect(query.status).toBe(400);
});

it("serves 503 in maintenance mode but keeps the data API closed too", async () => {
  const { createWorker } = await import("../src/worker");
  const { env } = await import("cloudflare:workers");
  const worker = createWorker({ github: {} as never });
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  for (const path of ["/", "/mcp", "/up/x", "/dl/x"]) {
    const res = await worker.fetch(
      new Request(`https://reef.cobular.com${path}`),
      { ...env, MAINTENANCE: "1" },
      ctx,
    );
    expect(res.status).toBe(503);
  }
});
