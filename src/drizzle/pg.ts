/**
 * `@xtandard/entitlements/drizzle/pg` — Drizzle table factories for the
 * entitlements state KV store and the counter store on Postgres.
 *
 * Schema-only (imports just `drizzle-orm/pg-core`, never the engine), so it is
 * safe to use inside a Drizzle schema file. Adding the tables to your schema
 * brings them into your normal `drizzle-kit` generate/migrate flow instead of an
 * adapter-side `CREATE TABLE`. Key columns are `text COLLATE "C"` so ordering
 * and `LIKE` prefixes are bytewise and case-sensitive whatever the database
 * default collation. `extraColumns`/`extraIndexes` mirror the `drizzle-audit`
 * factories for when you want to extend them.
 *
 * @example
 * ```ts
 * // schema.ts
 * import { pgCountersTable, pgEntitlementsTable } from "@xtandard/entitlements/drizzle/pg";
 * export const entitlementsKv = pgEntitlementsTable();
 * export const entitlementsCounters = pgCountersTable();
 *
 * // then: createDrizzleStorage({ db, table: entitlementsKv })
 * //       createDrizzleCounterStore({ db, table: entitlementsCounters })
 * ```
 *
 * @module
 */

import type { BuildExtraConfigColumns } from "drizzle-orm";
import {
  bigint,
  customType,
  doublePrecision,
  jsonb,
  pgSchema,
  pgTable,
  type PgColumnBuilderBase,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";

export type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";

/** `text COLLATE "C"` — bytewise, case-sensitive keys. */
const textC = customType<{ data: string; driverData: string }>({
  dataType: () => 'text COLLATE "C"',
});

/** The `self` passed to an {@link PgEntitlementsTableOptions.extraIndexes} callback. */
type PgColumns = BuildExtraConfigColumns<string, Record<string, PgColumnBuilderBase>, "pg">;

/** Options for {@link pgEntitlementsTable} and {@link pgCountersTable}. */
export interface PgEntitlementsTableOptions {
  /** Postgres schema (namespace) to place the table in. Defaults to the public schema. */
  schema?: string;
  /** Additional columns merged into the table (e.g. a tenant discriminator). */
  extraColumns?: () => Record<string, PgColumnBuilderBase>;
  /** Additional indexes/constraints; receives the built table for column references. */
  extraIndexes?: (table: PgColumns) => PgTableExtraConfigValue[];
}

/** Options for {@link pgCountersTable} (same knobs as the KV table). */
export type PgCountersTableOptions = PgEntitlementsTableOptions;

function build(
  name: string,
  columns: Record<string, PgColumnBuilderBase>,
  opts: PgEntitlementsTableOptions | undefined,
) {
  const all = { ...columns, ...opts?.extraColumns?.() };
  return opts?.schema
    ? pgSchema(opts.schema).table(name, all, opts.extraIndexes)
    : pgTable(name, all, opts?.extraIndexes);
}

/**
 * Build the Drizzle `pgTable` for the entitlements KV store. Base columns are
 * fixed — `key text COLLATE "C" PRIMARY KEY`, `value jsonb NOT NULL` — and
 * required by `createDrizzleStorage`; `schema`/`extraColumns`/`extraIndexes`
 * extend it. The table name defaults to `"xtandard_entitlements_kv"`.
 */
export function pgEntitlementsTable(
  name = "xtandard_entitlements_kv",
  opts?: PgEntitlementsTableOptions,
): DrizzleKvTable {
  return build(
    name,
    { key: textC("key").primaryKey(), value: jsonb("value").notNull() },
    opts,
  ) as unknown as DrizzleKvTable;
}

/**
 * Build the Drizzle `pgTable` for the counter store: `key text COLLATE "C"
 * PRIMARY KEY`, `value double precision NOT NULL DEFAULT 0`, `applied double
 * precision NOT NULL DEFAULT 0`, `expires_at bigint` (unix ms). Required by
 * `createDrizzleCounterStore`. The table name defaults to
 * `"xtandard_entitlements_counters"`.
 */
export function pgCountersTable(
  name = "xtandard_entitlements_counters",
  opts?: PgCountersTableOptions,
): DrizzleCounterTable {
  return build(
    name,
    {
      key: textC("key").primaryKey(),
      value: doublePrecision("value").notNull().default(0),
      applied: doublePrecision("applied").notNull().default(0),
      expiresAt: bigint("expires_at", { mode: "number" }),
    },
    opts,
  ) as unknown as DrizzleCounterTable;
}
