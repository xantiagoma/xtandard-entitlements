# Examples

Each example is a small, standalone project with a README and a `src/demo.ts` that exercises it
end to end and exits 0. They share one pricing model — [`shared/catalog.ts`](./shared/catalog.ts):
**free** (default), **pro** (v2 with a 14-day trial, and a grandfathered **v1**), **business**, the
**extra_seats** add-on, and the features `seats`, `api_calls`, `ai_credits` (+ `gpt_tokens` at
0.01 credits per token), `export_pdf`, `sso` and `max_upload_mb` — and the same seeded demo
customers ([`shared/seed.ts`](./shared/seed.ts)).

| Example                                 | What it shows                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`hono/`](./hono)                       | Panel at `/billing` (admin UI + portal + API), a metered `requireEntitlement` route, a portal-token route.  |
| [`elysia/`](./elysia)                   | The same with Elysia 1: the typed panel plugin, `beforeHandle` guards, an Eden treaty client.               |
| [`elysia2/`](./elysia2)                 | The same with Elysia 2 (`@xtandard/entitlements/elysia2`, `@elysia/eden`).                                  |
| [`express/`](./express)                 | The same with Express 5 (panel mounted **before** the body parser).                                         |
| [`bun/`](./bun)                         | No framework: `Bun.serve` routes, `requireEntitlement(…)(handler)`.                                         |
| [`next/`](./next)                       | Next.js App Router: `toNextHandler` catch-all, `withEntitlement` route handlers, a server action.           |
| [`react-app/`](./react-app)             | Vite + React: provider, `<Gate>`, `<UsageMeter>`, `<PricingTable>`, `<UpgradePrompt>`, `<CustomerPortal>`.  |
| [`stripe-webhooks/`](./stripe-webhooks) | Stripe billing: signed events (no network) land as plan changes; duplicates, out-of-order, legacy prices.   |
| [`ai-credits/`](./ai-credits)           | LLM tokens against a credit pool: `reserve` / `settle`, `onThreshold` alerts, expiry sweep, top-ups.        |
| [`flags-bridge/`](./flags-bridge)       | `@xtandard/flags` rules targeting `plan` / `entitlement.*` via an OpenFeature hook; entitlements as flags.  |
| [`postgres-redis/`](./postgres-redis)   | **Split planes**: Postgres state + Redis counters across two instances, buffered counters (docker compose). |
| [`storage-drivers/`](./storage-drivers) | One scenario over memory / file + kv-CAS / SQLite / libSQL / Postgres (PGlite) — the ports in action.       |

Every server example has the same routes, so their demos run the same scenario
([`shared/scenario.ts`](./shared/scenario.ts)): a `402` with `unlockedBy` for a free customer on a
Pro feature, `401` without a customer, the 1 001st call of a 1 000-call plan refused and not
counted, an idempotent retry metered once, an operator grant, and a portal token that is scoped to
one customer.

## Run from the repo root

```bash
bun install                            # once, at the repo root
bun run examples:hono                  # a server on a free port → http://localhost:3000/billing
bun run examples:hono --demo           # its non-interactive demo; exits 0 on success
bun run examples:demos                 # every demo, one after another
```

Names: `hono`, `elysia`, `elysia2`, `express`, `bun`, `next`, `react-app`, `stripe-webhooks`,
`ai-credits`, `flags-bridge`, `postgres-redis`, `storage-drivers`.

In this repo the examples run **from source** — no build, no per-example install:
[`tsconfig.json`](./tsconfig.json) maps every `@xtandard/entitlements/*` import to `src/` (Bun honors
tsconfig `paths` at runtime, and `bun run typecheck:examples` checks them), and framework packages
resolve from the root `node_modules`. Exceptions: `next` installs Next.js into the example on first
run, `elysia2` runs with its own tsconfig so `elysia` resolves to Elysia 2, and `react-app`'s
`vite.config.ts` aliases the React entry points to `src/` (Vite doesn't read tsconfig `paths`). The admin UI
is a built bundle — run `bun run build` once to see it; the APIs and demos work without it.

## Copying an example out

Each example's `package.json` depends on `"@xtandard/entitlements": "file:../.."` plus its
framework. Copy the folder and [`shared/`](./shared) next to it, swap the dependency for the
published version (`"@xtandard/entitlements": "^0.1.0"`), `bun install`, then `bun run start` /
`bun run demo`. For `next`, also drop the in-repo `paths` from its `tsconfig.json` and
`turbopack.root` from `next.config.mjs`; for `elysia2`, delete its `tsconfig.json`.

## Storage backends

| Backend                  | State storage      | Counters                  | Demonstrated in                                                         |
| ------------------------ | ------------------ | ------------------------- | ----------------------------------------------------------------------- |
| memory                   | `storage/memory`   | `counters/memory`         | most demos, [`storage-drivers/`](./storage-drivers)                     |
| file                     | `storage/file`     | `counters/kv` (CAS on it) | the servers (`./.entitlements`), `storage-drivers/`                     |
| SQLite (`bun:sqlite`)    | `storage/sqlite`   | `counters/sqlite`         | [`storage-drivers/`](./storage-drivers)                                 |
| libSQL / Turso           | `storage/libsql`   | `counters/libsql`         | [`storage-drivers/`](./storage-drivers)                                 |
| Postgres (`pg` / PGlite) | `storage/postgres` | `counters/postgres`       | [`postgres-redis/`](./postgres-redis), `storage-drivers/`               |
| Redis                    | `storage/redis`    | `counters/redis`          | [`postgres-redis/`](./postgres-redis), `storage-drivers/` (`REDIS_URL`) |
| write-behind             | —                  | `counters/buffered`       | [`postgres-redis/`](./postgres-redis)                                   |

MongoDB, Drizzle, unstorage and Cloudflare KV share the same contracts — see the
[Storage guide](../docs/STORAGE.md).
