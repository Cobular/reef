import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
      return {
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            GITHUB_CLIENT_ID: "test-client-id",
            GITHUB_CLIENT_SECRET: "test-client-secret",
            TOKEN_SIGNING_KEY: "test-token-signing-key-0123456789abcdef",
            COOKIE_SECRET: "test-cookie-secret-0123456789abcdef",
            // A local .dev.vars may point PUBLIC_ORIGIN at localhost; tests expect the real one.
            PUBLIC_ORIGIN: "https://reef.cobular.com",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
