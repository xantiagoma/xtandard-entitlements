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
 * The KV table is `pgKvTable` from `@xtandard/kit/drizzle/pg`, with the
 * entitlements name and `COLLATE "C"` key passed explicitly.
 *
 * @module
 */

import { pgKvTable, textC, type PgKvTableOptions } from "@xtandard/kit/drizzle/pg";
import {
  bigint,
  doublePrecision,
  pgSchema,
  pgTable,
  text,
  type PgColumnBuilderBase,
} from "drizzle-orm/pg-core";
import type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";

export type { DrizzleCounterTable, DrizzleKvTable } from "./table.ts";

/**
 * Options for {@link pgEntitlementsTable} and {@link pgCountersTable}: `schema`,
 * `extraColumns`, `extraIndexes`, and `keyCollation` (default `"C"`; `null`
 * declares a plain `text` key).
 */
export type PgEntitlementsTableOptions = PgKvTableOptions;

/** Options for {@link pgCountersTable} (same knobs as the KV table). */
export type PgCountersTableOptions = PgEntitlementsTableOptions;

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
  return pgKvTable(name, { keyCollation: "C", ...opts });
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
  const columns: Record<string, PgColumnBuilderBase> = {
    key: (opts?.keyCollation === null ? text("key") : textC("key")).primaryKey(),
    value: doublePrecision("value").notNull().default(0),
    applied: doublePrecision("applied").notNull().default(0),
    expiresAt: bigint("expires_at", { mode: "number" }),
    ...opts?.extraColumns?.(),
  };
  const table = opts?.schema
    ? pgSchema(opts.schema).table(name, columns, opts.extraIndexes)
    : pgTable(name, columns, opts?.extraIndexes);
  return table as unknown as DrizzleCounterTable;
}
