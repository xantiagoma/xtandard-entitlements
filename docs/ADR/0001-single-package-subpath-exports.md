# ADR 0001 — Single Package with Subpath Exports

**Status:** Accepted (mirrors `@xtandard/flags` ADR 0001 and `@xtandard/webhooks` ADR 0001)

---

## Context

`@xtandard/entitlements` ships a wide surface: the catalog DSL, the engine, state-storage drivers
(memory, file, Redis, Postgres, Drizzle, MongoDB, SQLite, libSQL, unstorage, Cloudflare KV), counter
drivers, billing providers (Stripe, Polar, Paddle, Lemon Squeezy, better-auth Stripe, manual), a flags
bridge, auth/authorization providers, framework adapters, React hooks and embeds, a bundled admin SPA,
a CLI and test helpers. Many pull optional peers (`pg`, `redis`, `mongodb`, `drizzle-orm`, `elysia`,
`hono`, `express`, `react`, `@openfeature/server-sdk`, …).

Both siblings settled the "many packages vs one" trade-off the same way.

## Decision

Ship **one npm package with explicit subpath exports** mapping to thin `src/entry-*.ts` re-export
entrypoints, built by vite-plus (`vp pack`) into dual ESM/CJS bundles with `.d.mts`/`.d.cts`.

Every new subpath needs four edits or CI-only failures appear: `src/entry-*.ts`, `vite.config.ts`
`pack.entry`, `package.json` `exports`, and `examples/tsconfig.json` `paths`.

`@xtandard/entitlements/catalog` has **zero dependencies** (not even valibot) so it can be imported by
browsers, edge runtimes and marketing sites (ADR 0002). The engine's hot path (`check`, `consume`) has
no optional dependencies either.

## Consequences

- One version, one release pipeline, one README, one docs site.
- Missing optional peers fail at import time with an actionable `requirePeer` message.
- `publint` and `npm pack --dry-run` guard the exports map in CI.
