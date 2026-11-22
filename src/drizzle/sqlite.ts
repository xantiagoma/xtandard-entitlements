/**
 * `@xtandard/entitlements/drizzle/sqlite` — SQLite Drizzle table factories for
 * the entitlements state KV store and the counter store. Schema-only (imports
 * just `drizzle-orm/sqlite-core`).
 *
 * Keys are `text PRIMARY KEY` with SQLite's default `BINARY` collation
 * (case-sensitive); the adapters match prefixes with `GLOB`, never the
 * case-folding `LIKE`. `extraColumns`/`extraIndexes` mirror `drizzle-audit`.
 *
 * @example
 * ```ts
 * import { sqliteCountersTable, sqliteEntitlementsTable } from "@xtandard/entitlements/drizzle/sqlite";
 * export const entitlementsKv = sqliteEntitlementsTable();
 * export const entitlementsCounters = sqliteCountersTable();
 * ```
 *
 * The KV table is `sqliteKvTable` from `@xtandard/kit/drizzle/sqlite`.
 *
 * @module
 */

import type { BuildColumns } from "drizzle-orm";
import { sqliteKvTable, type SqliteKvTableOptions } from "@xtandard/kit/drizzle/sqlite";
import {
  integer,
  real,
  sqliteTable,
  text,
  type SQLiteColumnBuilderBase,
  type SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";
import type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";

export type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";

/** Options for {@link sqliteEntitlementsTable} and {@link sqliteCountersTable}. */
export type SqliteEntitlementsTableOptions = SqliteKvTableOptions;

/** Options for {@link sqliteCountersTable} (same knobs as the KV table). */
export type SqliteCountersTableOptions = SqliteEntitlementsTableOptions;

/**
 * Build the SQLite `sqliteTable` for the entitlements KV store: `key text
 * PRIMARY KEY`, `value text NOT NULL` (JSON mode). The table name defaults to
 * `"xtandard_entitlements_kv"`.
 */
export function sqliteEntitlementsTable(
  name = "xtandard_entitlements_kv",
  opts?: SqliteEntitlementsTableOptions,
): DrizzleKvTable {
  return sqliteKvTable(name, opts);
}

/**
 * Build the SQLite `sqliteTable` for the counter store: `key text PRIMARY KEY`,
 * `value real NOT NULL DEFAULT 0`, `applied real NOT NULL DEFAULT 0`,
 * `expires_at integer` (unix ms). The table name defaults to
 * `"xtandard_entitlements_counters"`.
 */
export function sqliteCountersTable(
  name = "xtandard_entitlements_counters",
  opts?: SqliteCountersTableOptions,
): DrizzleCounterTable {
  const columns = {
    key: text("key").primaryKey(),
    value: real("value").notNull().default(0),
    applied: real("applied").notNull().default(0),
    expiresAt: integer("expires_at"),
    ...opts?.extraColumns?.(),
  } satisfies Record<string, SQLiteColumnBuilderBase>;
  // The public `extraIndexes` type uses a generic column map, a supertype of the inferred one.
  const extraConfig = opts?.extraIndexes as
    | ((self: BuildColumns<string, typeof columns, "sqlite">) => SQLiteTableExtraConfigValue[])
    | undefined;
  return sqliteTable(name, columns, extraConfig) as unknown as DrizzleCounterTable;
}
