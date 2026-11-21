# Storage

Two ports, two jobs (ADR 0004): **state storage** holds small documents (customer state, reservations, provider links, activity) behind the four-method KV contract shared with `@xtandard/flags` and `@xtandard/webhooks`; the **counter store** holds usage, where every increment must be one atomic backend operation. Pick each independently.

## State storage: the contract

```ts
interface EntitlementsStorage {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
  getKeys(prefix: string): Promise<string[]>;
}
```

Optional capabilities (separate interfaces + guards): `watch` (change notifications), `transaction`, and `compareAndSwap`. The engine writes customer documents with a `revision`: with `compareAndSwap` it retries on conflict, which is safe across any number of instances; without it, it serializes writes with an in-process per-customer mutex, which is only safe for a single instance.

## State storage drivers

| Subpath                                           | Factory                                        | Peers            | watch                              | CAS                         |
| ------------------------------------------------- | ---------------------------------------------- | ---------------- | ---------------------------------- | --------------------------- |
| `storage/memory`                                  | `createMemoryStorage`                          | —                | ✓                                  | ✓ (in-process)              |
| `storage/file`                                    | `createFileStorage`                            | —                | ✓ (`fs.watch`)                     | ✓ (in-process lock)         |
| `storage/redis`                                   | `createRedisStorage`, `createRedisJSONStorage` | `redis`          | ✓ (keyspace notifications)         | ✓ (Lua, structural compare) |
| `storage/postgres`                                | `createPostgresStorage`                        | `pg` / PGlite    | via `withWatch` + `pgListenNotify` | ✓ (`jsonb` equality)        |
| `storage/drizzle`                                 | `createDrizzleStorage`                         | `drizzle-orm`    | via `withWatch`                    | ✓ (pg / mysql / sqlite)     |
| `drizzle/pg` / `drizzle/mysql` / `drizzle/sqlite` | `pgEntitlementsTable` etc.                     | `drizzle-orm`    |                                    |                             |
| `storage/mongodb`                                 | `createMongoStorage`                           | `mongodb`        |                                    | ✓ (`$expr` equality)        |
| `storage/sqlite`                                  | `createSqliteStorage`                          | — (`bun:sqlite`) |                                    | ✓ (canonical JSON)          |
| `storage/libsql`                                  | `createLibsqlStorage`                          | `@libsql/client` |                                    | ✓ (canonical JSON)          |
| `storage/unstorage`                               | `createUnstorageStorage`                       | `unstorage`      |                                    |                             |
| `storage/cloudflare-kv`                           | `createCloudflareKvStorage`                    | — (binding)      |                                    |                             |

Default names say entitlements: the SQL table is `xtandard_entitlements_kv`, the MongoDB database / collection `xtandard_entitlements` / `entitlements_kv`. Redis and Cloudflare KV take an optional `prefix` (joined with `:`).

Conventions shared by every adapter (ported from flags/webhooks): factories return `satisfies`-closed literals; `ownsClient = !options.client` — borrowed clients are never closed; optional peers load via a lazy, memoized dynamic `import()` with an actionable `requirePeer` error; `close()` only closes what the adapter opened.

### Keys are exact

Keys are case-, accent- and byte-exact on every driver, and `getKeys(prefix)` matches the prefix literally — the conformance suite checks `Acme` ≠ `acme`, `café` ≠ `cafe`, and prefixes containing `% _ ! \ * [ ? ] : #`:

- Postgres keys are `text COLLATE "C"`; `LIKE … ESCAPE '!'` (a backslash escape is a syntax error on MySQL, so `!` everywhere).
- MySQL keys are `varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin` — the default `utf8mb4_0900_ai_ci` would make `…/Acme` and `…/acme` the same row.
- SQLite / libSQL use `GLOB` (SQLite's `LIKE` folds ASCII case).
- Every SQL, Redis and MongoDB `getKeys` also post-filters with an exact `startsWith`.
- The file driver encodes each path segment (`A` → `^a`, non-`[a-z0-9._~!@,=+-]` bytes → `%XX`), so keys stay distinct on case- and normalization-insensitive macOS / Windows volumes and can never escape the base directory.
- unstorage rewrites `\`, `/` and `:` to `:` and drops everything after `?`; the adapter percent-encodes `% : \ ? $` so its key normalization is lossless.

### How compare-and-swap works per driver

| Driver                | `compareAndSwap` is…                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Redis / RedisJSON     | one Lua script: `cjson`-decode stored and expected values, compare structurally, write on match                                 |
| Postgres              | `UPDATE … WHERE key = $1 AND value = $2::jsonb` (or `INSERT … ON CONFLICT DO NOTHING` when absence is expected)                 |
| SQLite / libSQL       | values are stored as canonical JSON (sorted keys), so `UPDATE … WHERE value = ?` is exact                                       |
| Drizzle               | the same per dialect: `jsonb` equality (pg), `CAST(? AS JSON)` equality (MySQL), canonical JSON text (SQLite)                   |
| MongoDB               | `updateOne({ _id, $expr: { $eq: ["$value", { $literal: expected }] } })`; values are written with sorted keys                   |
| File                  | a per-key lock around read → compare → write-then-rename — **one process only**                                                 |
| unstorage, Workers KV | not available — no shared atomic primitive (KV is eventually consistent); fine for one instance, pair with a real counter store |

## Counters: the contract

```ts
interface CounterStore {
  get(keys: readonly string[]): Promise<number[]>; // missing → 0
  add(
    key: string,
    amount: number,
    opts?: { max?: number; min?: number; partial?: boolean; expiresAt?: number },
  ): Promise<{ applied: number; value: number }>;
  set(key: string, value: number, opts?: { expiresAt?: number }): Promise<void>;
  claim(key: string, ttlMs: number): Promise<boolean>; // set-if-absent (idempotency)
  release(key: string): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  keys?(prefix: string): Promise<string[]>;
}
```

`add` with `max` is all-or-nothing unless `partial`; with `min` (refunds) it clamps at the floor. **Every `add` is one atomic operation in the backend** — the bounds decision is made where the value lives, never read-then-write — so N instances consuming the same counter can never push it past `max`, and a refused `add` never changes it (ADR 0005). The shared conformance suite (`test/counter-contract.ts`) runs 50–100 parallel bounded adds against every driver.

## Counter drivers

| Subpath             | Factory                      | Peers            | One atomic `add` is…                                                                                   | Claims                                       |
| ------------------- | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `counters/memory`   | `createMemoryCounterStore`   | —                | a synchronous JS critical section (one process)                                                        | in-memory TTL map                            |
| `counters/redis`    | `createRedisCounterStore`    | `redis`          | one Lua script (read, decide, `SET`, `PEXPIREAT`)                                                      | `SET NX PX`                                  |
| `counters/postgres` | `createPostgresCounterStore` | `pg` / PGlite    | `INSERT … ON CONFLICT (key) DO UPDATE SET … RETURNING value, applied`                                  | upsert that only takes an expired row        |
| `counters/sqlite`   | `createSqliteCounterStore`   | — (`bun:sqlite`) | the same upsert (SQLite serializes writers)                                                            | same                                         |
| `counters/libsql`   | `createLibsqlCounterStore`   | `@libsql/client` | the same upsert, executed by the primary                                                               | same                                         |
| `counters/mongodb`  | `createMongoCounterStore`    | `mongodb`        | `findOneAndUpdate` with an update pipeline (`$cond`) and `upsert`                                      | unique `_id` insert, or take over if expired |
| `counters/drizzle`  | `createDrizzleCounterStore`  | `drizzle-orm`    | pg / sqlite: the upsert above; MySQL: ordered `ON DUPLICATE KEY UPDATE` + read in the same transaction | same marker column                           |
| `counters/kv`       | `createKvCounterStore`       | any CAS storage  | a compare-and-swap retry loop (refuses storage without CAS)                                            | CAS on a claim document                      |
| `counters/buffered` | `createBufferedCounterStore` | wraps any store  | decided locally, flushed as one unbounded `add` per key (ADR 0006)                                     | pass-through                                 |

### The SQL counter table

```sql
-- Postgres (postgresCounterSchema(), or pgCountersTable() for Drizzle)
CREATE TABLE xtandard_entitlements_counters (
  key        text COLLATE "C" PRIMARY KEY,
  value      double precision NOT NULL DEFAULT 0,
  applied    double precision NOT NULL DEFAULT 0, -- what the last operation applied
  expires_at bigint                               -- unix ms; NULL = never
);
```

The upsert evaluates the bounds against the locked row inside the database and writes the decision into `applied`, so `RETURNING value, applied` hands back both atomically. MySQL has no `RETURNING`: its `ON DUPLICATE KEY UPDATE` assigns left to right (`applied`, then `value` and `expires_at` from it) and the row is read back in the same transaction while the row lock is held. Every number in these statements is a caller-supplied finite number inlined as its shortest round-trip literal; keys are always bound parameters.

Values are doubles: exact for integers up to 2^53, and fractional amounts follow IEEE arithmetic exactly as the memory driver does (Redis stores `%.17g` strings rather than using `INCRBYFLOAT`, whose long-double formatting drifts). Prefer integer minor units (tokens, milli-credits).

`expiresAt` is a retention hint: an expired counter reads as `0` and restarts on the next write. Redis expires the key itself (`PEXPIREAT`); MongoDB creates a TTL index on `expiresAt` (`ttlIndex: false` to skip); the SQL drivers keep expired rows until the next write or `purgeExpired()` — run it from a cron if you keep many short-lived series. Claims share the counter table / keyspace under the reserved `_claims/` prefix and never show up in `keys()`.

SQL tables are created on first use (`createTable: false` on Postgres when the runtime role may not run DDL — apply `postgresCounterSchema()` in a migration); Drizzle drivers never run DDL — the tables are in your schema.

## Which to pick

| Situation                                   | State storage                       | Counters                                          |
| ------------------------------------------- | ----------------------------------- | ------------------------------------------------- |
| Tests, local dev                            | `memory`                            | `memory`                                          |
| One instance, no database yet               | `file` or `sqlite`                  | `sqlite` (Bun) / `libsql` (file)                  |
| You already run Postgres                    | `postgres` or `drizzle`             | `postgres` or `drizzle` (same database)           |
| Hot metering (rate limits, tokens) at scale | your database                       | `redis`                                           |
| Edge / Workers                              | `libsql` (Turso) or `cloudflare-kv` | `libsql` (Turso) or a custom Durable Object store |
| MongoDB shop                                | `mongodb`                           | `mongodb`                                         |

### Mixing: Postgres state + Redis counters

```ts
import { createEntitlements } from "@xtandard/entitlements";
import { createPostgresStorage } from "@xtandard/entitlements/storage/postgres";
import { createRedisCounterStore } from "@xtandard/entitlements/counters/redis";

const ent = createEntitlements({
  catalog,
  storage: createPostgresStorage({ connectionString: process.env.DATABASE_URL }),
  counters: createRedisCounterStore({ url: process.env.REDIS_URL }),
});
```

Customer state stays durable and queryable in Postgres; every `consume` is one Redis round trip. The two never need a cross-store transaction: state writes are revisioned (CAS), counter writes are self-contained atomic operations, and the ledger refunds partial takes when a multi-bucket consume is refused.

### Buffered counters for soft meters

```ts
import { createBufferedCounterStore } from "@xtandard/entitlements/counters/buffered";

const strict = createRedisCounterStore({ url: process.env.REDIS_URL });
const ent = createEntitlements({
  catalog,
  storage,
  counters: {
    default: strict,
    buffered: createBufferedCounterStore(strict, { flushInterval: "1s", maxPending: 1000 }),
    features: { api_calls: "buffered" },
  },
});
```

The buffered store decides locally and flushes one `add` per key per interval. Across N instances a buffered limit can overshoot by at most N × the pending delta per key, so keep strict limits (seats, prepaid credits) on the strict store; decisions from the buffered path carry `buffered: true`.

## Writing your own adapter

Implement the four KV methods (plus `compareAndSwap` if your backend has an atomic conditional write) or the seven counter methods, then run the conformance suites from your test file:

```ts
import { runStorageContractTests } from "./storage-contract.ts";
import { runCounterContractTests } from "./counter-contract.ts";

runStorageContractTests("my-kv", () => createMyStorage(), { compareAndSwap: true });
runCounterContractTests("my-counters", () => createMyCounters(), { keys: true });
```

The counter contract's concurrency tests are the bar: if 50 parallel `add(key, 1, { max: 25 })` calls ever apply more than 25, the backend is not atomic and must not be used for limits.
