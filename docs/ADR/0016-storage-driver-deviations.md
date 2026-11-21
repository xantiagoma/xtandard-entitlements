# ADR 0016 — Storage and Counter Driver Deviations from the Siblings

**Status:** Accepted

---

## Context

ADR 0004 ports the ten flags/webhooks KV drivers unchanged and adds a counter port. Porting surfaced
bugs in the sibling drivers (case-folding collations, a MySQL-invalid `LIKE` escape, case- and
normalization-insensitive filesystems, unstorage's lossy key normalization) and the engine needs
`compareAndSwap` for revisioned customer writes, which webhooks only had in memory.

## Decision

State storage (same factory names and options; defaults say entitlements — `xtandard_entitlements_kv`):

- **Exact keys everywhere.** Postgres keys `text COLLATE "C"`; MySQL keys `varchar(512) CHARACTER SET
utf8mb4 COLLATE utf8mb4_bin`; `LIKE … ESCAPE '!'` (pg/mysql); `GLOB` on SQLite/libSQL; Redis
  `SCAN MATCH` glob-escaped; MongoDB regex-escaped; every `getKeys` post-filters with `startsWith`.
- **File driver** encodes path segments (`A` → `^a`, other bytes outside `[a-z0-9._~!@,=+-]` →
  `%XX`, leading `.` → `%2E`, empty → `%`), writes via temp file + rename, and has an in-process
  `compareAndSwap` (per-key lock). Mirrors `@xtandard/links`.
- **unstorage** percent-encodes `% : \ ? $` and lists the enclosing namespace, then filters.
- **compareAndSwap on every driver with an atomic conditional write:** Redis/RedisJSON (Lua +
  `cjson` structural compare), Postgres (`jsonb` equality), SQLite/libSQL (values stored as
  canonical JSON, single `UPDATE … WHERE value = ?`), Drizzle (per dialect), MongoDB (`$expr` +
  `$literal` equality; values written with sorted keys). Not on unstorage / Cloudflare KV.
- Webhooks' delivery-queue code (`claimDue`, due zset) is dropped.

Counters (new):

- SQL drivers share one core (`src/counters/sql.ts`): one table `key, value, applied, expires_at`;
  `add` is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING value, applied` whose bounds
  decision runs in the statement, with the `applied` column carrying the decision back. MySQL
  (Drizzle) orders its `ON DUPLICATE KEY UPDATE` assignments and reads back in the same
  transaction. Numbers are inlined as finite literals; keys are parameters.
- Claims share the counter keyspace under the reserved `_claims/` prefix (as `counters/kv` does).
- Redis stores `%.17g` strings via Lua instead of `INCRBYFLOAT`; MongoDB uses a pipeline
  `findOneAndUpdate` with upsert and a TTL index.

## Consequences

- The shared conformance suites (case/accent, metacharacters, `? \ ] : #`, CAS races, 50–100
  parallel bounded adds) pass on every driver, live backends included.
- `bun:sqlite` drivers are excluded from vitest coverage (covered by `bun run test:bun`).
- Backport candidates for flags/webhooks: collations, `ESCAPE '!'`, file encoding, unstorage
  encoding, SQL/Redis/Mongo compare-and-swap.
