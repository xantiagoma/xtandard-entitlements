/**
 * Postgres counter store: one `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * statement per atomic `add`, over `pg` or PGlite (ADR 0004).
 *
 * Import from `@xtandard/entitlements/counters/postgres`.
 *
 * @module counters/postgres
 */

export { createPostgresCounterStore, postgresCounterSchema } from "./counters/postgres.ts";
export type { PostgresCounterStore, PostgresCounterStoreOptions } from "./counters/postgres.ts";
