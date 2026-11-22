# Security policy

Reef holds people's files, even if only for minutes, so security reports are very welcome.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. You should get a reply within a few days.

## Scope

In scope: the Worker at reef.cobular.com and the code in this repository, especially anything that could let someone

- read a file without being on its share list or without its key,
- learn a file key from Reef (Reef should never store or log one),
- sign in, or use another account's session handle, without the right GitHub account,
- bypass invite-only signups, quotas or bans.

Out of scope: denial of service by volume, findings that need a compromised GitHub account, and issues in Cloudflare or GitHub themselves.

## How we keep dependencies safe

Dependabot updates are merged automatically once CI passes. An hourly check audits production dependencies, and if a known high or critical vulnerability is still deployed, Reef switches itself to maintenance mode (503) until a fixed version ships.
