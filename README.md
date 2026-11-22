# Reef

Reef is one Cloudflare Worker that hands files between AI agent sessions and people: short-lived,
encrypted with a key Reef does not keep, and reachable only by accounts on the file's share list.
Agents use it through an MCP connector at `/mcp`; people sign in with GitHub. `DESIGN.md` is the
spec.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts`, `src/worker.ts` | Entry point and routing |
| `src/auth-*.ts` | GitHub sign-in (MCP OAuth and portal), invite gating, signed cookies |
| `src/files-*.ts` | Tokens, the HTTP data API, R2 storage with SSE-C, D1 queries, cron cleanup |
| `src/mcp-*.ts` | The MCP server, its five file tools and their guidance text |
| `src/lib-*.ts` | Small shared helpers (HMAC, base64, HTML, cookies, logging) |
| `src/config.ts` | Limits and other constants |
| `migrations/` | D1 schema |

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # then fill it in; never commit it
pnpm exec wrangler d1 migrations apply reef --local
pnpm dev
```

`.dev.vars` needs:

| Name | Value |
| --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | A GitHub OAuth App for local use, with callback URL `http://localhost:8787/auth/callback` |
| `TOKEN_SIGNING_KEY` | Random secret, e.g. `openssl rand -base64 32` |
| `COOKIE_SECRET` | A different random secret, made the same way |
| `PUBLIC_ORIGIN` | `http://localhost:8787` (overrides the production value in `wrangler.jsonc`) |
| `SIGNUP_MODE` | Optional: `open` lets any GitHub account sign up locally |

`pnpm cf-typegen` reads `.dev.vars` if it exists and then writes the secrets into
`worker-configuration.d.ts`, which CI checks for drift. Move `.dev.vars` aside when you run
typegen; the secret types live in `src/env.d.ts`.

Checks (the same ones CI runs):

```sh
pnpm cf-typegen && pnpm lint && pnpm typecheck && pnpm test && pnpm exec wrangler deploy --dry-run --outdir dist
```

Tests run inside workerd through `@cloudflare/vitest-plugin`, with GitHub stubbed. Miniflare's
R2 accepts SSE-C keys but ignores them, so the tests emulate SSE-C at the storage boundary
(`test/helpers.ts`).

## Deploy

1. Create the resources and put their IDs in `wrangler.jsonc`:
   ```sh
   pnpm exec wrangler d1 create reef
   pnpm exec wrangler r2 bucket create reef-files
   pnpm exec wrangler kv namespace create OAUTH_KV
   ```
2. Add an R2 lifecycle rule on `reef-files` as a backstop to the cron job: delete objects after
   1 day and abort incomplete multipart uploads after 1 day.
3. Create a GitHub OAuth App (Settings, Developer settings, OAuth Apps) with homepage
   `https://reef.cobular.com` and callback URL `https://reef.cobular.com/auth/callback`. GitHub
   accepts any path under the registered callback, and Reef uses `/auth/callback/mcp` and
   `/auth/callback/portal`. Reef asks for no scopes.
4. Set the secrets:
   ```sh
   pnpm exec wrangler secret put GITHUB_CLIENT_ID
   pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
   pnpm exec wrangler secret put TOKEN_SIGNING_KEY   # openssl rand -base64 32
   pnpm exec wrangler secret put COOKIE_SECRET       # a different random value
   ```
   Rotating `TOKEN_SIGNING_KEY` voids outstanding upload and download links; rotating
   `COOKIE_SECRET` signs everyone out of the portal.
5. Apply the schema and deploy:
   ```sh
   pnpm exec wrangler d1 migrations apply reef --remote
   pnpm run deploy
   ```

## Accounts

With `SIGNUP_MODE=invite` (the default), only GitHub logins in `invites` can create an account.
Logins match case-insensitively.

```sh
# Invite someone
pnpm exec wrangler d1 execute reef --remote --command "INSERT INTO invites (login, created_at) VALUES ('octocat', unixepoch() * 1000)"
# Suspend an account (takes effect on its next request, everywhere)
pnpm exec wrangler d1 execute reef --remote --command "UPDATE users SET banned = 1 WHERE login = 'octocat'"
```

To connect an agent, add `https://reef.cobular.com/mcp` as a remote MCP server in the client.
It signs in through the browser with GitHub.
