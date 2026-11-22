/**
 * `@xtandard/entitlements/drizzle/mysql` — MySQL Drizzle table factories for
 * the entitlements state KV store and the counter store. Schema-only (imports
 * just `drizzle-orm/mysql-core`).
 *
 * Key columns are `varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`:
 * MySQL's default `utf8mb4_0900_ai_ci` is case- and accent-insensitive, which
 * would make `ent/customers/Acme` and `ent/customers/acme` the same primary key.
 * `extraColumns`/`extraIndexes` mirror `drizzle-audit`.
 *
 * @example
 * ```ts
 * import { mysqlCountersTable, mysqlEntitlementsTable } from "@xtandard/entitlements/drizzle/mysql";
 * export const entitlementsKv = mysqlEntitlementsTable();
 * export const entitlementsCounters = mysqlCountersTable();
 * ```
 *
 * The KV table is `mysqlKvTable` from `@xtandard/kit/drizzle/mysql`; the counter
 * table reuses its `binVarchar` key column.
 *
 * @module
 */

import type { BuildColumns } from "drizzle-orm";
import { binVarchar, mysqlKvTable, type MysqlKvTableOptions } from "@xtandard/kit/drizzle/mysql";
import {
  bigint,
  double,
  mysqlTable,
  type MySqlColumnBuilderBase,
  type MySqlTableExtraConfigValue,
} from "drizzle-orm/mysql-core";
import type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";

export type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";
export type { MysqlKeyCollation } from "@xtandard/kit/drizzle/mysql";

/**
 * Options for {@link mysqlEntitlementsTable} and {@link mysqlCountersTable}:
 * `keyLength` (default `512`), `keyCollation` (default `"utf8mb4_bin"`; pass
 * `"utf8mb4_0900_bin"` on MySQL 8.0+ or `"utf8mb4_nopad_bin"` on MariaDB for a
 * NO PAD key), `extraColumns` and `extraIndexes`.
 */
export type MysqlEntitlementsTableOptions = MysqlKvTableOptions;

/** Options for {@link mysqlCountersTable} (same knobs as the KV table). */
export type MysqlCountersTableOptions = MysqlEntitlementsTableOptions;

/**
 * Build the MySQL `mysqlTable` for the entitlements KV store: `key varchar
 * … COLLATE utf8mb4_bin PRIMARY KEY`, `value json NOT NULL`. The table name
 * defaults to `"xtandard_entitlements_kv"`.
 */
export function mysqlEntitlementsTable(
  name = "xtandard_entitlements_kv",
  opts?: MysqlEntitlementsTableOptions,
): DrizzleKvTable {
  return mysqlKvTable(name, opts);
}

/**
 * Build the MySQL `mysqlTable` for the counter store: `key varchar … COLLATE
 * utf8mb4_bin PRIMARY KEY`, `value double NOT NULL DEFAULT 0`, `applied double
 * NOT NULL DEFAULT 0`, `expires_at bigint` (unix ms). The table name defaults
 * to `"xtandard_entitlements_counters"`.
 */
export function mysqlCountersTable(
  name = "xtandard_entitlements_counters",
  opts?: MysqlCountersTableOptions,
): DrizzleCounterTable {
  const columns = {
    key: binVarchar("key", opts?.keyLength ?? 512, opts?.keyCollation).primaryKey(),
    value: double("value").notNull().default(0),
    applied: double("applied").notNull().default(0),
    expiresAt: bigint("expires_at", { mode: "number" }),
    ...opts?.extraColumns?.(),
  } satisfies Record<string, MySqlColumnBuilderBase>;
  // The public `extraIndexes` type uses a generic column map, a supertype of the inferred one.
  const extraConfig = opts?.extraIndexes as
    | ((self: BuildColumns<string, typeof columns, "mysql">) => MySqlTableExtraConfigValue[])
    | undefined;
  return mysqlTable(name, columns, extraConfig) as unknown as DrizzleCounterTable;
}
