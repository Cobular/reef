#!/usr/bin/env node
// Daily usage check against the Cloudflare free-plan allowances, run by .github/workflows/usage.yml.
// Reads yesterday's (UTC) totals from the GraphQL Analytics API and prints a Markdown table.
// Exits 0 always; writes `alert=true` to $GITHUB_OUTPUT when anything is at or above ALERT_AT.
//
// Env: CF_ANALYTICS_TOKEN (Account Analytics: Read), CF_ACCOUNT_ID (optional: looked up if unset).
// Field names follow developers.cloudflare.com (checked 2026-11-23); KV action types are lower-case.

import { appendFileSync } from "node:fs";

const ALERT_AT = 0.6;
const SCRIPT = "reef";
const DATABASE_ID = "0c3aeb8d-9236-419e-8ef9-426057fa1595";
const BUCKET = "reef-files";
const GiB = 1024 ** 3;

// Workers Free daily allowances (R2's is monthly storage, compared with the day's peak).
const LIMITS = {
  "Worker requests": 100_000,
  "KV reads": 100_000,
  "KV writes": 1_000,
  "KV deletes": 1_000,
  "D1 rows read": 5_000_000,
  "D1 rows written": 100_000,
  "R2 storage (GiB)": 10,
};

const token = process.env.CF_ANALYTICS_TOKEN;
if (!token) {
  console.log("CF_ANALYTICS_TOKEN is not set; skipping the usage check.");
  process.exit(0);
}

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await res.json();
  if (!res.ok || body.success === false || body.errors?.length) {
    throw new Error(`${path}: ${JSON.stringify(body.errors ?? body).slice(0, 500)}`);
  }
  return body;
}

// An Analytics-only token can't list accounts, so the account ID usually has to be given.
const account = process.env.CF_ACCOUNT_ID || (await cf("/accounts")).result?.[0]?.id;
if (!account) {
  console.error("Set the CF_ACCOUNT_ID secret: this token can't look up the account ID itself.");
  process.exit(1);
}
const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const start = `${day}T00:00:00Z`;
const end = `${day}T23:59:59Z`;

const query = `query($account: String!, $day: Date!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 10000, filter: { scriptName: "${SCRIPT}", datetime_geq: $start, datetime_leq: $end }) { sum { requests errors } }
    kv: kvOperationsAdaptiveGroups(limit: 100, filter: { date_geq: $day, date_leq: $day }) { sum { requests } dimensions { actionType } }
    d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: { databaseId: "${DATABASE_ID}", date_geq: $day, date_leq: $day }) { sum { rowsRead rowsWritten } }
    r2: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: "${BUCKET}", datetime_geq: $start, datetime_leq: $end }) { max { payloadSize objectCount } }
  } }
}`;

const data = await cf("/graphql", {
  method: "POST",
  body: JSON.stringify({ query, variables: { account, day, start, end } }),
});
const a = data.data.viewer.accounts[0];
const sum = (rows, f) => rows.reduce((n, r) => n + (f(r) ?? 0), 0);
const kv = (type) =>
  sum(
    a.kv.filter((r) => r.dimensions.actionType === type),
    (r) => r.sum.requests,
  );

const used = {
  "Worker requests": sum(a.workers, (r) => r.sum.requests),
  "KV reads": kv("read"),
  "KV writes": kv("write"),
  "KV deletes": kv("delete"),
  "D1 rows read": sum(a.d1, (r) => r.sum.rowsRead),
  "D1 rows written": sum(a.d1, (r) => r.sum.rowsWritten),
  "R2 storage (GiB)": (a.r2[0]?.max.payloadSize ?? 0) / GiB,
};

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2));
let alert = false;
const lines = [
  `### Reef usage on ${day} (UTC)`,
  "",
  "| Meter | Used | Free allowance | Share |",
  "| --- | ---: | ---: | ---: |",
];
for (const [name, limit] of Object.entries(LIMITS)) {
  const share = used[name] / limit;
  if (share >= ALERT_AT) alert = true;
  const mark = share >= 1 ? " 🔴" : share >= ALERT_AT ? " 🟠" : "";
  lines.push(
    `| ${name} | ${fmt(used[name])} | ${fmt(limit)} | ${(share * 100).toFixed(1)}%${mark} |`,
  );
}
const errors = sum(a.workers, (r) => r.sum.errors);
lines.push("", `Worker errors: ${fmt(errors)}.`);
if (alert) {
  lines.push(
    "",
    `Something is at ${ALERT_AT * 100}% or more of a free daily allowance. When this keeps happening, move to Workers Paid ($5/month), whose included usage is far higher.`,
  );
}

const report = lines.join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `alert=${alert}\nreport<<EOF\n${report}\nEOF\n`);
}
