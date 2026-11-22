import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("responds", async () => {
  const res = await SELF.fetch("https://reef.cobular.com/");
  expect(res.status).toBe(200);
});
