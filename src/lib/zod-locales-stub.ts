// Bundled in place of zod's `locales/index.js` (see "alias" in wrangler.jsonc), so the Worker does
// not ship zod's ~48 translated error-message files. zod registers English itself (classic
// schemas import `locales/en.js` directly), so messages stay English; only the unused
// `z.locales` / `z.core.locales` namespaces become empty.
export {};
