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
 * @module
 */

import type { BuildColumns } from "drizzle-orm";
import {
  bigint,
  customType,
  double,
  json,
  mysqlTable,
  type MySqlColumnBuilderBase,
  type MySqlTableExtraConfigValue,
} from "drizzle-orm/mysql-core";
import type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";

export type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";

/** The `self` passed to an {@link MysqlEntitlementsTableOptions.extraIndexes} callback. */
type MysqlColumns = BuildColumns<string, Record<string, MySqlColumnBuilderBase>, "mysql">;

/** Options for {@link mysqlEntitlementsTable} and {@link mysqlCountersTable}. */
export interface MysqlEntitlementsTableOptions {
  /**
   * `varchar` length for the `key` primary key. Default `512` (keys are short
   * slash-delimited paths). Keep within your InnoDB index-prefix limit.
   */
  keyLength?: number;
  /** Additional columns merged into the table. */
  extraColumns?: () => Record<string, MySqlColumnBuilderBase>;
  /** Additional indexes/constraints; receives the built table for column references. */
  extraIndexes?: (table: MysqlColumns) => MySqlTableExtraConfigValue[];
}

/** Options for {@link mysqlCountersTable} (same knobs as the KV table). */
export type MysqlCountersTableOptions = MysqlEntitlementsTableOptions;

/** A binary-collated (case-sensitive, byte-exact) varchar key column. */
function binaryKey(length: number) {
  return customType<{ data: string; driverData: string }>({
    dataType: () => `varchar(${length}) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  })("key").primaryKey();
}

function build(
  name: string,
  columns: Record<string, MySqlColumnBuilderBase>,
  opts: MysqlEntitlementsTableOptions | undefined,
) {
  const all = { ...columns, ...opts?.extraColumns?.() };
  // Cast to the exact `self` type Drizzle infers from `columns` — the public
  // `extraIndexes` type uses a generic column map, which is a supertype.
  const extraConfig = opts?.extraIndexes as
    | ((self: BuildColumns<string, typeof all, "mysql">) => MySqlTableExtraConfigValue[])
    | undefined;
  return mysqlTable(name, all, extraConfig);
}

/**
 * Build the MySQL `mysqlTable` for the entitlements KV store: `key varchar
 * … COLLATE utf8mb4_bin PRIMARY KEY`, `value json NOT NULL`. The table name
 * defaults to `"xtandard_entitlements_kv"`.
 */
export function mysqlEntitlementsTable(
  name = "xtandard_entitlements_kv",
  opts?: MysqlEntitlementsTableOptions,
): DrizzleKvTable {
  return build(
    name,
    { key: binaryKey(opts?.keyLength ?? 512), value: json("value").notNull() },
    opts,
  ) as unknown as DrizzleKvTable;
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
  return build(
    name,
    {
      key: binaryKey(opts?.keyLength ?? 512),
      value: double("value").notNull().default(0),
      applied: double("applied").notNull().default(0),
      expiresAt: bigint("expires_at", { mode: "number" }),
    },
    opts,
  ) as unknown as DrizzleCounterTable;
}
