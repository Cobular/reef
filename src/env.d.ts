// Secrets are set with `wrangler secret put` and are not visible to `wrangler types`.
// Declaring them here keeps worker-configuration.d.ts reproducible in CI.
interface ReefSecrets {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  TOKEN_SIGNING_KEY: string;
  COOKIE_SECRET: string;
}

declare namespace Cloudflare {
  interface Env extends ReefSecrets {}
}

interface Env extends ReefSecrets {}
