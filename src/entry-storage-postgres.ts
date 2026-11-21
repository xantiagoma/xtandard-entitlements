/**
 * Postgres state storage: one `jsonb` key/value table over `pg` or PGlite,
 * created on first use, with single-statement compare-and-swap.
 *
 * Import from `@xtandard/entitlements/storage/postgres`.
 *
 * @module storage/postgres
 */

export { createPostgresStorage, postgresStorageSchema } from "./storage/postgres.ts";
export type {
  ClosableSqlClient,
  PostgresEntitlementsStorage,
  PostgresStorageOptions,
  SqlClient,
} from "./storage/postgres.ts";
