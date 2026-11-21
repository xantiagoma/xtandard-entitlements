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
 * @module
 */

import type { BuildColumns } from "drizzle-orm";
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

/** The `self` passed to an {@link SqliteEntitlementsTableOptions.extraIndexes} callback. */
type SqliteColumns = BuildColumns<string, Record<string, SQLiteColumnBuilderBase>, "sqlite">;

/** Options for {@link sqliteEntitlementsTable} and {@link sqliteCountersTable}. */
export interface SqliteEntitlementsTableOptions {
  /** Additional columns merged into the table. */
  extraColumns?: () => Record<string, SQLiteColumnBuilderBase>;
  /** Additional indexes/constraints; receives the built table for column references. */
  extraIndexes?: (table: SqliteColumns) => SQLiteTableExtraConfigValue[];
}

/** Options for {@link sqliteCountersTable} (same knobs as the KV table). */
export type SqliteCountersTableOptions = SqliteEntitlementsTableOptions;

function build(
  name: string,
  columns: Record<string, SQLiteColumnBuilderBase>,
  opts: SqliteEntitlementsTableOptions | undefined,
) {
  const all = { ...columns, ...opts?.extraColumns?.() };
  // Cast to the exact `self` type Drizzle infers from `columns` — the public
  // `extraIndexes` type uses a generic column map, which is a supertype.
  const extraConfig = opts?.extraIndexes as
    | ((self: BuildColumns<string, typeof all, "sqlite">) => SQLiteTableExtraConfigValue[])
    | undefined;
  return sqliteTable(name, all, extraConfig);
}

/**
 * Build the SQLite `sqliteTable` for the entitlements KV store: `key text
 * PRIMARY KEY`, `value text NOT NULL` (JSON mode). The table name defaults to
 * `"xtandard_entitlements_kv"`.
 */
export function sqliteEntitlementsTable(
  name = "xtandard_entitlements_kv",
  opts?: SqliteEntitlementsTableOptions,
): DrizzleKvTable {
  return build(
    name,
    { key: text("key").primaryKey(), value: text("value", { mode: "json" }).notNull() },
    opts,
  ) as unknown as DrizzleKvTable;
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
  return build(
    name,
    {
      key: text("key").primaryKey(),
      value: real("value").notNull().default(0),
      applied: real("applied").notNull().default(0),
      expiresAt: integer("expires_at"),
    },
    opts,
  ) as unknown as DrizzleCounterTable;
}
