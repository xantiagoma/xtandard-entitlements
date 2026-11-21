/**
 * The table shapes the Drizzle adapters read/write, expressed with the
 * **stable, dialect-agnostic** root `drizzle-orm` types (`Table`/`Column`).
 *
 * The `*EntitlementsTable` / `*CountersTable` factories annotate their return
 * as these types on purpose: returning the raw inferred `PgTableWithColumns<…>`
 * would (a) freeze the version-specific internal column brand into the emitted
 * `.d.ts` — breaking consumers on a different `drizzle-orm` (e.g. 1.0 beta,
 * whose `Column` shape differs) — and (b) not be nameable across the
 * `schema`/no-`schema` union (TS2883). These types use only public types and are
 * all the adapters need.
 *
 * @module
 */

import type { Column, Table } from "drizzle-orm";

export type { DrizzleKvTable } from "@xtandard/kit/drizzle/pg";

/**
 * A table with the fixed columns the Drizzle counter store requires: `key`
 * (primary key), `value` (double), `applied` (double — the amount the last
 * operation on the row applied, returned atomically with the new value) and
 * `expiresAt` (bigint unix ms, nullable).
 */
export type DrizzleCounterTable = Table & {
  key: Column;
  value: Column;
  applied: Column;
  expiresAt: Column;
};
