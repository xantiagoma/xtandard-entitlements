# Changelog

All notable changes to `@xtandard/entitlements`. Versions follow ZeroVer (`0.x`); entries are
generated from conventional commits with `changelogen` (see [Releases](./docs/RELEASES.md)).

## v0.2.0

[compare changes](https://github.com/xantiagoma/xtandard-entitlements/compare/v0.1.1...v0.2.0)

No export is removed and stored data is read as before. One type-level change: `RedisLike` lists `zAdd`, `zRem` and `zRangeByScore`, so a hand-written client implementing it needs those. Some HTTP details change: `Allow` includes `HEAD`, and the non-API 405 is now JSON.

`@xtandard/entitlements` now builds on [`@xtandard/kit`](https://me.xantiagoma.com/xtandard-kit/),
the shared building blocks of the xtandard products. Most of the kit was extracted from
entitlements, so this release is mostly deletions: the storage drivers, drizzle KV tables, auth,
authorization, hooks runner, ids/durations/validation core, portal-token mechanics, panel handler,
router and OpenAPI generator, framework adapters, CLI plumbing, admin-UI primitives and embed
plumbing, build configs, docs-site tooling and CI workflows are the kit's. Entitlements keeps its
domain (engine, catalog, counters, billing, bridges, views, `./react` hooks) and thin wrappers that
pass its defaults explicitly: table/collection names (`xtandard_entitlements_kv`,
`xtandard_entitlements` / `entitlements_kv`), the `xtandard_entitlements` pg channel, the
`xtandard-entitlements` realm, the `entpt_` prefix and 1-hour TTL, `ulid-lower22` ids, the `423`
readonly status, `__ENTITLEMENTS_CONFIG__`, the `xtandard-entitlements:theme` key and the
`.xtandard-entitlements` scope class. Every subpath and exported name is kept (API-surface diff: 1
added, 0 removed; every subpath now also imports under Node). Stored data is read as before.

The kit is a regular dependency (`^0.1.1`): you never install or configure it. Kit patch releases reach you
on your next install, without an entitlements release.

### Fixed

Storage (inherited from the kit; each has a permanent case in the shared conformance suite):

- **MySQL (drizzle):** `getKeys` no longer skips keys containing supplementary characters (emoji):
  MySQL 8.4's range optimizer missed them for an indexed `LIKE 'p%'` on the `utf8mb4_bin` key; the
  prefix is now a bytewise range plus `startsWith`. The drizzle counter store's `keys()` too.
- **MySQL (drizzle) PAD SPACE:** keys that differ only by trailing spaces no longer cross on the
  default `utf8mb4_bin` key (`setItem("a ")` overwrote `"a"`): reads, removes and swaps match
  byte-exactly, and a colliding write throws `KeyCollisionError` (exported from
  `./storage/drizzle`). Entitlements' own keys are segment-encoded, so they never end in a space.
  New tables can opt into a NO PAD key (`keyCollation: "utf8mb4_0900_bin"`, MariaDB
  `"utf8mb4_nopad_bin"`); migration SQL in `docs/STORAGE.md`.
- **unstorage:** a stored string that looks like JSON (`"123"`) now reads back as that string (it
  came back as the number `123`). Strings are written JSON-encoded; strings stored by earlier
  releases read as before.
- **Postgres / drizzle:** a stored JSON string that looks like JSON reads back as that string (it
  was parsed a second time).
- **Redis:** `getKeys` no longer returns duplicates (SCAN may repeat a key).
- **Redis CAS:** compares the stored text with canonical JSON instead of `cjson`-decoding both, so
  `{}` and `[]` are different values; values written in another key order (or serialized
  differently by RedisJSON) still swap through a structural fallback.
- **Mongo CAS:** a document written with fields in another order swaps through a structural
  fallback (BSON equality is field-order sensitive).
- **Memory CAS:** structural equality checks own properties (`{ a: undefined }` ≠
  `{ b: undefined }`).
- **unstorage:** empty key segments are distinct keys (`a//b` ≠ `a/b`).
- **Postgres / libSQL / Mongo / SQLite:** a failed connect or DDL is retried on the next call.
- `withWatch` results survive an object spread.

Server, CLI and adapters:

- **Ids are monotonic within a millisecond:** ids minted in the same millisecond, or under a clock
  that went backwards, still sort in creation order (the generator drew fresh randomness per id).
  The format is unchanged.
- **Express / Node:** every `Set-Cookie` header is kept (they were collapsed into one), multi-value
  request headers are appended, responses are streamed with backpressure, and the body is cancelled
  when the client disconnects. The CLI's Node server uses the same bridge.
- **Elysia:** `DELETE` bodies are rebuilt too, a stale `content-length` is never forwarded, form,
  byte and string bodies keep their type, and two mounts with different prefixes are not
  deduplicated.
- **index.html:** the base href and the bootstrap JSON (`<`, `>`, U+2028/U+2029) are escaped, not
  only the title; `$` sequences are kept verbatim.
- **SPA HTML is `cache-control: no-cache`**, so an upgrade never serves a stale `index.html`
  pointing at deleted hashed assets; `assets/*` stay immutable.
- **The static file server** rejects paths into prefix-sharing sibling directories.
- **JSON values must be finite** in API inputs (`NaN` / `Infinity` serialised to `null`).
- **Portal tokens** reject an empty secret on verify too.
- **The CLI runs itself only when executed directly** (`bun src/cli.ts`, `node dist/cli.mjs`), not
  when imported.
- `--port` must be a valid port.

UI and embeds:

- `routing: "memory"` keeps the query string (scope params like `?customer=` were dropped).
- `<CustomerPortal>` invalidates cached queries when its `token` changes (a new token may carry a
  different scope) and clears the token on unmount.
- The host-theme watcher works without `MutationObserver`.
- API error bodies always carry the real HTTP `status`.
- The embed stylesheet's leak guard also catches token blocks left on `:root` / `html` / `body` and
  re-homes compound root selectors (`:root.dark`, `:root:not(…)`); a unit suite now checks it.

Docs site and CI:

- The API reference has one overview page per entry point with re-export links; `og:image:alt`,
  favicon sizes and `theme-color` tags; https `og:url` / sitemap.
- CI typechecks the examples and runs the RedisJSON live suite; a `docker.yml` workflow builds,
  smoke-tests and publishes the standalone image to GHCR (with a `refresh-kit` dispatch input for
  kit security patches).

Kit v0.1.1 also fixes behaviour this release would otherwise have regressed: negative numbers and a
lone `-` as CLI flag values (`override --value -5`, `--reason -`), the `SectionCard` regions the
admin UI names by title, the readonly `423` message (`Cannot <operation>: @xtandard/entitlements is
in readonly mode.`), the panel on Node 20.0–20.15, portal-token expiry under fake timers, and a
`valibot`-free engine and counter path (`@xtandard/kit/util/core`) all work as before.

### Changed

- `405` responses list `HEAD` in `Allow` for paths with a `GET` route (`HEAD` was already served).
  A non-API path with a method other than `GET` / `HEAD` answers a JSON `405` with `Allow: GET,
HEAD` (was a plain-text `405`).
- The panel also serves the OpenAPI document at `/openapi.json` (besides `/api/openapi.json`).
- `Authorization: bearer entpt_…` is recognized case-insensitively.
- Portal tokens: `createPortalToken` / `verifyPortalToken` accept a list of secrets for rotation
  (the first signs, any verifies). Newly minted tokens order their payload `{ customer, scope, exp }`
  (was `{ customer, exp, scope }`); tokens from either release verify. `PortalTokenError` is now
  also an instance of the kit's `TokenError`.
- `storage/sqlite` and `counters/sqlite` load `bun:sqlite` on first use: importing them under Node
  no longer throws (opening a database still needs Bun), and the table is created on first use
  instead of in the constructor, so a bad path surfaces on the first call.
- `createPostgresStorage()` may be called without options (the lazily created `pg` pool then reads
  the standard `PG*` environment variables).
- Driver errors (missing peer, missing `client`/`url`) name the entitlements import path.
- The `after`-hook error warning reads `[@xtandard/entitlements] after-hook for "<type>" threw:`.
- `RedisLike` (`./storage/redis`) is the kit's structural client type, which also lists `zAdd`,
  `zRem` and `zRangeByScore` (node-redis clients have them).
- New options: `keyCollation` on the drizzle table factories (`"C"` / `null` on pg; the MySQL NO
  PAD collations; the `MysqlKeyCollation` type), `STORAGE_SQLITE_TABLE` / `COUNTERS_SQLITE_TABLE` /
  `STORAGE_LIBSQL_URL` env vars for the CLI and image.
- Admin UI: the buttons, inputs, dialogs, toasts, theme toggle and layout bits are the kit's
  (same design system; small visual differences possible).

### Migration

None required: no export was removed, stored data and HTTP status codes are unchanged. If you
implement `RedisLike` yourself (rather than passing a node-redis client), add the three sorted-set
methods.

## v0.1.1

Docs-only release so npm shows the current README.

### Documentation

- **readme:** npm link in the ecosystem row; `@xtandard/audit` and `@xtandard/links` in the ecosystem table ([#12](https://github.com/xantiagoma/xtandard-entitlements/pull/12), [#22](https://github.com/xantiagoma/xtandard-entitlements/pull/22))
- **site:** "The xtandard ecosystem" cards on the docs home page ([#23](https://github.com/xantiagoma/xtandard-entitlements/pull/23))

### Chore

- **fmt:** pre-commit formatting no longer fails on `.mdx`- or `CHANGELOG.md`-only commits ([#24](https://github.com/xantiagoma/xtandard-entitlements/pull/24))

## v0.1.0

First release.

### Features

- **Catalog** (`/catalog`, zero dependencies): `defineCatalog` with boolean, metered, credits, capacity
  and value features; plans with groups, defaults, trials and versions (grandfathering); add-ons with
  quantities and `requires`; provider item mappings; `pricingTable()`; fully typed keys and values.
- **Engine**: `createEntitlements` — memory-first per-customer snapshots with last-known-good and
  explicit fallbacks; `check` / `consume` / `release` / `reserve` + `settle` with buckets (allowance →
  one-off grants → overage) where a refusal never counts; credits (`creditCost`); idempotency keys;
  once-per-period thresholds; decisions with `reason`, 402-vs-403 `denial` and `unlockedBy`; grants,
  overrides, trials, plan migration, usage set/reset, provider links, activity, daily usage series;
  `before` / `after` hooks; `onUsage` / `onThreshold` taps; `/testing` engine with a test clock.
- **Storage** (10 state drivers: memory, file, Redis + RedisJSON, Postgres, Drizzle pg/mysql/sqlite,
  MongoDB, SQLite, libSQL, unstorage, Cloudflare KV) and **counters** (memory, buffered write-behind,
  KV over compare-and-swap, Redis, Postgres, SQLite, libSQL, MongoDB, Drizzle), each with a
  conformance suite.
- **Billing**: `createBilling` intake (verified, idempotent, order-safe webhooks; reconcile; checkout
  and billing-portal link-outs; usage export) with Stripe, Polar, Paddle, Lemon Squeezy, better-auth
  Stripe and manual providers — no SDK dependencies.
- **Flags bridge** (`/flags`): OpenFeature provider, hook and context enricher for `@xtandard/flags`.
- **Bridges** to `@xtandard/audit` and `@xtandard/webhooks`.
- **Panel**: `createFetchHandler` with the admin + runtime + portal HTTP API (OpenAPI 3.1), auth
  (none / basic / delegated), authorization (none / roles / delegated), customer-scoped portal
  tokens, CORS, a log hook; adapters for Bun, Hono, Express, Elysia 1 and 2, Next.js, with
  `requireEntitlement` guards.
- **UI**: admin SPA and customer portal; `/react` hooks and components (`Gate`, `UsageMeter`,
  `PricingTable`, `UpgradePrompt`); `/react/embed` dashboard and portal.
- **CLI** (`xtandard-entitlements`: serve, check, consume, grant, override, subscribe, customers,
  pricing, sweep) and a standalone Bun server + Dockerfile.
- Examples (11), docs site, brand kit.
