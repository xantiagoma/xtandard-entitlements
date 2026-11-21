/**
 * Postgres counter store (ADR 0004) over any client exposing `query(text,
 * params?) => Promise<{ rows }>` — a [`pg`](https://node-postgres.com) `Pool` /
 * `Client` or an in-process `@electric-sql/pglite`. Pass `pool` (or `client`),
 * or a `connectionString`/`url` to lazily create a `pg` `Pool`.
 *
 * Every `add` is **one** statement — `INSERT … ON CONFLICT (key) DO UPDATE SET
 * … RETURNING value, applied` — whose bounds check runs against the locked row
 * inside the database, so any number of instances can meter the same counter
 * without over-granting (see {@link ./sql.sqlCounterStore}). Claims are an
 * `INSERT … ON CONFLICT DO UPDATE` that only takes an expired row. Values are
 * `double precision` (exact for integers up to 2^53).
 *
 * The table is created on first use (`createTable: false` to skip, e.g. when the
 * runtime role may not run DDL — apply {@link postgresCounterSchema} in a
 * migration instead).
 *
 * @module
 */

import { assertIdentifier } from "@xtandard/kit/storage";
import { pgConnection, pgReady, type SqlClient } from "@xtandard/kit/storage/postgres/internals";
import { counterTableSql, sqlCounterStore, type SqlCounterStore } from "./sql.ts";

/** Options for {@link createPostgresCounterStore}. */
export interface PostgresCounterStoreOptions {
  /** A `pg` `Pool` / `Client`, or a PGlite instance. */
  pool?: SqlClient;
  /** Alias for {@link PostgresCounterStoreOptions.pool}. */
  client?: SqlClient;
  /** Connection string used to lazily create a `pg` `Pool` when no `pool` is given. */
  connectionString?: string;
  /** Alias for {@link PostgresCounterStoreOptions.connectionString}. */
  url?: string;
  /** Table name (default `"xtandard_entitlements_counters"`). Must be a safe SQL identifier. */
  table?: string;
  /** Run `CREATE TABLE IF NOT EXISTS` on first use. Default `true`. */
  createTable?: boolean;
  /** Clock (unix ms) for expiry hints and claim TTLs. Default `Date.now`. */
  now?: () => number;
}

/** A Postgres {@link SqlCounterStore} plus `close()` (ends a pool this store created). */
export interface PostgresCounterStore extends SqlCounterStore {
  close(): Promise<void>;
}

/**
 * The counter table DDL — `key text COLLATE "C" PRIMARY KEY, value double
 * precision, applied double precision, expires_at bigint` — for migrations.
 */
export function postgresCounterSchema(table = "xtandard_entitlements_counters"): string {
  return counterTableSql("pg", assertIdentifier(table));
}

/**
 * Create a Postgres-backed counter store.
 *
 * @example
 * ```ts
 * import { Pool } from "pg";
 * import { createPostgresCounterStore } from "@xtandard/entitlements/counters/postgres";
 *
 * const counters = createPostgresCounterStore({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) });
 * ```
 */
export function createPostgresCounterStore(
  options: PostgresCounterStoreOptions = {},
): PostgresCounterStore {
  const table = assertIdentifier(options.table ?? "xtandard_entitlements_counters");
  const connection = pgConnection(
    options.pool ?? options.client,
    options.connectionString ?? options.url,
    "@xtandard/entitlements/counters/postgres",
  );
  const ready = pgReady(
    connection,
    options.createTable === false ? [] : [counterTableSql("pg", table)],
  );

  return {
    ...sqlCounterStore({
      dialect: "pg",
      table,
      now: options.now ?? Date.now,
      exec: async () => {
        const c = await ready();
        return { all: async (sql, args) => (await c.query(sql, args)).rows };
      },
    }),
    close: connection.close,
  };
}
