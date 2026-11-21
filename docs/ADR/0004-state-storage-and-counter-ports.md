# ADR 0004 — Two Ports: KV State Storage + Atomic Counter Store

**Status:** Accepted ★ (state storage mirrors the flags/webhooks KV contract; the counter port is new)

---

## Context

Entitlements hold two very different kinds of data:

1. **State** — subscriptions, grants, overrides, provider links, reservations, audit entries: small
   documents, read-mostly, written by humans and webhooks.
2. **Usage** — counters incremented on hot paths, concurrently, where "read then write" loses updates
   and over-grants (the classic `remaining > 0 → do work → increment` race).

Flags' four-method KV contract is ideal for (1) and impossible for (2): it has no atomic increment.
Closure and Stigg both split the hot counter path (Redis) from the durable store.

## Decision

**State storage** is `EntitlementsStorage` — the flags contract unchanged (`getItem`, `setItem`,
`removeItem`, `getKeys`, optional `watch`, `transaction`, `compareAndSwap`). We ship the same ten
drivers with the same factory names and options (`createMemoryStorage`, `createRedisStorage`, …) and
the same conformance suite. Customer documents carry a `revision`; mutations use `compareAndSwap`
when available (retrying on conflict) and an in-process per-customer mutex otherwise.

**Counters** are a new port, `CounterStore`:

```ts
interface CounterStore {
  get(keys: string[]): Promise<number[]>; // missing → 0
  add(
    key: string,
    amount: number,
    opts?: {
      max?: number; // never exceed (all-or-nothing unless partial)
      min?: number; // never go below (refunds clamp at 0)
      partial?: boolean; // apply as much as fits instead of nothing
      expiresAt?: number; // retention hint (unix ms); drivers may ignore
    },
  ): Promise<{ applied: number; value: number }>;
  set(key: string, value: number, opts?: { expiresAt?: number }): Promise<void>;
  claim(key: string, ttlMs: number): Promise<boolean>; // set-if-absent (idempotency)
  release(key: string): Promise<void>; // drop a claim
  delete(keys: string[]): Promise<void>;
  keys?(prefix: string): Promise<string[]>; // admin / graphs
}
```

Every `add` is a **single atomic operation** in the backend: a JS critical section (memory), a Lua
script (Redis), one `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING` (Postgres, SQLite, libSQL,
Drizzle), `findOneAndUpdate` with an update pipeline (MongoDB). `createKvCounterStore(storage)` adapts
any state storage that implements `compareAndSwap` (CAS retry loop) and refuses to construct otherwise.

Drivers: memory, buffered (ADR 0006), redis, postgres, sqlite (bun:sqlite), libsql, mongodb, drizzle
(pg / mysql / sqlite), kv (CAS). A shared **counter conformance suite** runs against each, including
a concurrency test (N parallel `add` with `max` must never exceed `max`).

Amounts are JS numbers. Drivers must be exact for integers up to 2^53 and should store doubles;
docs recommend integer minor units (e.g. tokens, milli-credits).

## Consequences

- Hosts can keep state in Postgres and counters in Redis, or both in one database.
- The counter port is small enough that a custom backend (DynamoDB, Durable Objects) is ~60 lines.
