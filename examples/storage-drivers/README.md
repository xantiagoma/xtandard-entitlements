# Storage drivers × @xtandard/entitlements

Two ports — **state storage** (customers, subscriptions, grants) and **counters** (atomic usage) —
and one scenario run over several pairs of drivers. The engine code is identical every time; only
the two constructor arguments change ([`src/demo.ts`](./src/demo.ts)).

| Pair                         | State storage                                 | Counters                                         |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------ |
| memory + memory              | `storage/memory`                              | `counters/memory`                                |
| file + kv-CAS                | `storage/file`                                | `counters/kv` — a CAS retry loop on that storage |
| sqlite + sqlite              | `storage/sqlite` (`bun:sqlite`)               | `counters/sqlite` — same database file           |
| libsql + libsql              | `storage/libsql` (`file:` URL)                | `counters/libsql`                                |
| postgres (PGlite) + postgres | `storage/postgres` (in-process WASM Postgres) | `counters/postgres`                              |
| redis + redis (`REDIS_URL`)  | `storage/redis`                               | `counters/redis`                                 |

## The scenario

1. Subscribe a customer to Pro (10 seats).
2. **50 concurrent** `consume(org, "seats")` → exactly **10** granted: every counter driver's `add`
   is one atomic bounded operation, and refusals never count.
3. `consume(…, { idempotencyKey })` twice → applied once (`duplicate: true`).
4. A grant (+250 AI credits) and an override (SSO on) — state-storage writes.
5. Persistent drivers: a **second engine** over the same backends reads it all back.

## Run it

```bash
bun run examples:storage-drivers --demo          # from the repo root; exits 0
REDIS_URL=redis://localhost:6379 bun run examples:storage-drivers --demo
```

Picking drivers, how compare-and-swap and atomic `add` work per backend, and writing your own:
[Storage guide](../../docs/STORAGE.md). Postgres state with Redis counters (and write-behind
counters) across two instances: [`../postgres-redis`](../postgres-redis).
