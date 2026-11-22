# Deployment

The shapes, the standalone image, the full env contract, and the security posture to read before
production.

## Shapes

1. **Embedded** (the default) — the engine runs inside your app: `check()` is a memory read,
   `consume()` one atomic counter step. Mount the panel (admin UI + portal + HTTP API + billing
   webhooks) with any adapter ([ADAPTERS.md](./ADAPTERS.md)). With several replicas, every replica
   serves checks from its own snapshot cache; pick shared storage + counters (Postgres / Redis /
   …, see [STORAGE.md](./STORAGE.md)) so they agree, and a watchable storage (or a short cache
   `ttl`) so plan changes propagate.
2. **Standalone** — the Docker image serves the panel and the HTTP API; services in other languages
   meter through the runtime API (`POST /api/v1/check | consume | reserve | settle`, see
   [HTTP_API.md](./HTTP_API.md)) with a `runtime-service` principal.
3. **CLI** — `xtandard-entitlements serve` is the standalone server without Docker; the one-shot
   commands (`check`, `consume`, `grant`, `override`, `subscribe`, `customers`, `pricing`, `sweep`)
   operate on the same storage for support and CI.

## Standalone / Docker

```sh
docker build -f apps/standalone/Dockerfile -t xtandard-entitlements .
docker run -p 3000:3000 \
  -v $PWD/catalog.ts:/app/catalog.ts -e CATALOG_PATH=/app/catalog.ts \
  -e STORAGE_DRIVER=postgres -e COUNTERS_DRIVER=redis \
  -e DATABASE_URL=postgres://… -e REDIS_URL=redis://redis:6379 \
  -e AUTH_MODE=basic -e AUTH_USERNAME=ops -e AUTH_PASSWORD_HASH='<scrypt hash>' \
  -e PORTAL_SECRET='<random string>' \
  xtandard-entitlements
```

The catalog is code: mount your `catalog.ts` (a module exporting `catalog`, or a default export)
and point `CATALOG_PATH` at it. Without one the image serves a bundled example catalog — fine for
a demo, never for production. `/healthcheck` answers `{ ok: true }` for orchestrator probes.

## CLI

```sh
npx @xtandard/entitlements serve --catalog ./src/catalog.ts --port 3005
xtandard-entitlements check --catalog ./catalog.ts --customer org_42 --feature api_calls  # exit 2 = denied
xtandard-entitlements grant --catalog ./catalog.ts --customer org_42 --feature ai_credits --amount 1000 --reason "ticket #123"
xtandard-entitlements override --catalog ./catalog.ts --customer org_42 --feature export_pdf --enabled true --expires-at 2026-12-31T00:00:00Z
xtandard-entitlements pricing --catalog ./catalog.ts > public/pricing.json
```

`--storage` / `--counters` override `STORAGE_DRIVER` / `COUNTERS_DRIVER`. Exit codes: `0` ok, `1`
error / usage, `2` denied (`check` / `consume`). Changes made from the CLI are attributed to the
actor `{ id: "cli", type: "system" }`.

## Environment variables (CLI `serve` and the image)

| Variable                                                                             | Meaning                                                        | Default                                                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------- |
| `CATALOG_PATH` (or `--catalog`)                                                      | module exporting the catalog                                   | required (image: bundled example)                       |
| `STORAGE_DRIVER`                                                                     | `memory` `file` `redis` `postgres` `mongodb` `sqlite` `libsql` | `file` (image: `memory`)                                |
| `COUNTERS_DRIVER`                                                                    | `memory` `kv` `redis` `postgres` `mongodb` `sqlite` `libsql`   | `kv` if the storage has compare-and-swap, else `memory` |
| `REDIS_URL`, `STORAGE_PREFIX`, `COUNTERS_PREFIX`                                     | redis connection + key prefixes                                | `redis://localhost:6379`                                |
| `DATABASE_URL` or `POSTGRES_URL`, `STORAGE_PG_TABLE`, `COUNTERS_PG_TABLE`            | postgres                                                       | table `xtandard_entitlements_kv`                        |
| `MONGO_URL`, `MONGO_DB`, `STORAGE_MONGO_COLLECTION`, `COUNTERS_MONGO_COLLECTION`     | mongodb                                                        | db `xtandard_entitlements`                              |
| `STORAGE_FILE_DIR`                                                                   | file driver dir                                                | `./.entitlements/state`                                 |
| `STORAGE_SQLITE_PATH`, `COUNTERS_SQLITE_PATH`                                        | sqlite (Bun only)                                              | `./.entitlements/*.sqlite`                              |
| `STORAGE_SQLITE_TABLE`, `COUNTERS_SQLITE_TABLE`                                      | sqlite / libsql table                                          | `xtandard_entitlements_kv` / `…_counters`               |
| `LIBSQL_URL` (or `STORAGE_LIBSQL_URL`), `COUNTERS_LIBSQL_URL`, `LIBSQL_AUTH_TOKEN`   | libsql / Turso                                                 | `file:./.entitlements/*.db`                             |
| `PORT`, `BASE_PATH`, `TITLE`, `LOGO_URL`                                             | HTTP + branding                                                | `3000`, `/`, `@xtandard/entitlements`                   |
| `READONLY`                                                                           | control-plane mutations answer `423`; metering keeps working   | `false`                                                 |
| `AUTH_MODE`, `AUTH_USERNAME`, `AUTH_ROLE`, `AUTH_PASSWORD_HASH` (or `AUTH_PASSWORD`) | `none` / `basic`                                               | `none`, `admin`, `admin`                                |
| `PORTAL_SECRET`                                                                      | enables customer-portal tokens                                 | off                                                     |
| `SWEEP_INTERVAL`                                                                     | release expired reservations this often (`0` disables)         | `1m`                                                    |

An empty variable counts as unset. An unknown `STORAGE_DRIVER`, `COUNTERS_DRIVER` or `AUTH_MODE`
fails at startup instead of falling back.

The startup banner prints where state lives (file / sqlite paths resolved to absolute) but never a
connection string.

## Security posture — read this

- **The panel is an admin surface.** `auth: none` is a quickstart default, not a deployment. Use
  basic / delegated auth + the role presets, or keep the panel off the public internet and expose
  only the portal and the webhook intake.
- **The runtime API spends money.** `/api/v1/consume` moves real balances. Give service accounts
  the `runtime-service` role, not `admin`, and never call it from browsers — browsers read their
  own state through portal tokens or your app.
- **Billing webhooks** (`POST /webhooks/:provider`) are unauthenticated by design; the provider
  signature is the credential. Keep the raw body intact (mount Express before body parsers) and
  configure each provider's signing secret.
- **Portal tokens are bearer credentials** — HTTPS only, short `expiresIn`; rotating
  `PORTAL_SECRET` is the revocation story ([PORTAL.md](./PORTAL.md)).
- **Fail-closed by default.** If the counter store is down, `consume` denies (`counterFallback:
"deny"`); if a customer can't be loaded and nothing is cached, the default plan applies
  (`fallback: "default-plan"`). Choose deliberately (ADR 0003).
- **Your data, your database.** Customer state, grants, overrides and activity live in your storage
  unencrypted — the database is the trust boundary. Encrypt the volume and back it up.

## Operational checklist

- [ ] Shared storage + counters for multi-replica deployments; backups
- [ ] Auth + authorization on the panel; `runtime-service` principals for `/api/v1/*`
- [ ] `PORTAL_SECRET` set only if the portal is used; short token lifetimes
- [ ] Billing provider signing secrets configured; webhook route reachable from the provider
- [ ] `SWEEP_INTERVAL` (or `sweepInterval`) so abandoned reservations return their units
- [ ] `onUsage` / `onThreshold` wired to metrics and alerting; `hooks` (e.g. `hooks/log`) to audit
