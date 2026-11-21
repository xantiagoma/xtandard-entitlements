/**
 * libSQL / Turso state storage over `@libsql/client` (remote, embedded replica
 * or local file), with single-statement compare-and-swap.
 *
 * Import from `@xtandard/entitlements/storage/libsql`.
 *
 * @module storage/libsql
 */

export { createLibsqlStorage } from "./storage/libsql.ts";
export type {
  LibsqlClientLike,
  LibsqlEntitlementsStorage,
  LibsqlStorageOptions,
} from "./storage/libsql.ts";
