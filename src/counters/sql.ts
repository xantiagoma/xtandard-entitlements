/**
 * The SQL counter core shared by the Postgres, SQLite, libSQL and Drizzle
 * counter drivers (ADR 0004). Internal — import a driver subpath instead.
 *
 * ## Table
 *
 * One row per counter: `key` (primary key; bytewise collation), `value`
 * (double), `applied` (double — the amount the *last* operation on the row
 * applied) and `expires_at` (bigint unix ms, nullable). A row whose
 * `expires_at` has passed reads as `0` and is reset by the next write.
 * Claims live in the same table under the reserved `_claims/` key prefix.
 *
 * ## One atomic statement per `add`
 *
 * `add` is a single `INSERT … ON CONFLICT (key) DO UPDATE SET applied = A,
 * value = V, expires_at = E RETURNING value, applied`. The bounds decision
 * (`max` / `min` / `partial`, mirroring {@link computeApplied}) is evaluated
 * **inside** the statement against the row's current value, under the row
 * lock — never read-then-write — and the `applied` column hands back how much
 * of the amount was applied, atomically with the new value. A refusal writes
 * `applied = 0` and leaves `value` untouched.
 *
 * Every number in these statements comes from the caller as a finite JS
 * number ({@link assertAmount}) and is inlined as a SQL literal (shortest
 * round-trip decimal, so the backend parses the identical double); keys are
 * always bound parameters.
 *
 * @module
 */

import { escapeGlob, escapeLike } from "@xtandard/kit/storage";
import {
  assertAmount,
  computeApplied,
  type CounterAddOptions,
  type CounterStore,
} from "./contract.ts";

/** Key prefix reserved for claims (shares the counter table / keyspace). */
export const CLAIM_PREFIX = "_claims/";

/** Fully quoted column references used inside `DO UPDATE SET` expressions. */
export interface CounterColumnRefs {
  value: string;
  applied: string;
  expiresAt: string;
}

/** A finite JS number as a SQL literal (negative numbers parenthesized). */
export function sqlNumber(n: number): string {
  assertAmount(n);
  const s = String(n);
  return n < 0 ? `(${s})` : s;
}

/** A unix-ms timestamp as a SQL integer literal, or `NULL`. */
const sqlTime = (ms: number | undefined): string =>
  ms === undefined ? "NULL" : sqlNumber(Math.trunc(ms));

/** The SQL expression for {@link computeApplied} against a current-value expression. */
export function appliedSql(cur: string, amount: number, options: CounterAddOptions): string {
  const a = sqlNumber(amount);
  if (amount > 0 && options.max !== undefined) {
    const room = `(${sqlNumber(options.max)} - ${cur})`;
    const refused = options.partial ? `(CASE WHEN ${room} > 0 THEN ${room} ELSE 0 END)` : "0";
    return `(CASE WHEN ${a} > ${room} THEN ${refused} ELSE ${a} END)`;
  }
  if (amount < 0 && options.min !== undefined) {
    const room = `(${cur} - ${sqlNumber(options.min)})`;
    const refused = options.partial ? `(CASE WHEN ${room} > 0 THEN (0 - ${room}) ELSE 0 END)` : "0";
    return `(CASE WHEN ${sqlNumber(-amount)} > ${room} THEN ${refused} ELSE ${a} END)`;
  }
  return a;
}

/** `SET` expressions + inserted values for one `add`. */
export interface CounterAddSql {
  /** Column values for the INSERT branch (row absent: current value is 0). */
  insert: { value: number; applied: number; expiresAt: number | null };
  /** `DO UPDATE SET` expressions, in the order they must be assigned. */
  set: { applied: string; value: string; expiresAt: string };
}

/**
 * Build the expressions for an atomic `add`. With `sequential` (MySQL, whose
 * `ON DUPLICATE KEY UPDATE` assigns left to right and later expressions see
 * earlier assignments) `value` and `expires_at` reuse the freshly assigned
 * `applied` column; otherwise (Postgres, SQLite: every expression sees the old
 * row) the applied expression is repeated.
 */
export function counterAddSql(
  cols: CounterColumnRefs,
  amount: number,
  options: CounterAddOptions,
  now: number,
  sequential = false,
): CounterAddSql {
  assertAmount(amount);
  const expired = `(${cols.expiresAt} IS NOT NULL AND ${cols.expiresAt} <= ${sqlTime(now)})`;
  const cur = `(CASE WHEN ${expired} THEN 0 ELSE ${cols.value} END)`;
  const applied = appliedSql(cur, amount, options);
  const appliedRef = sequential ? cols.applied : applied;
  const exp = sqlTime(options.expiresAt);
  const insertApplied = computeApplied(0, amount, options);
  return {
    insert: {
      value: insertApplied,
      applied: insertApplied,
      expiresAt: options.expiresAt === undefined ? null : Math.trunc(options.expiresAt),
    },
    set: {
      applied,
      value: `(${cur} + ${appliedRef})`,
      // Memory semantics: an expired row restarts with the new hint; an applied
      // change takes the new hint (or keeps the old one); a refusal keeps it.
      expiresAt:
        options.expiresAt === undefined
          ? `(CASE WHEN ${expired} THEN NULL ELSE ${cols.expiresAt} END)`
          : `(CASE WHEN ${expired} OR ${appliedRef} <> 0 THEN ${exp} ELSE ${cols.expiresAt} END)`,
    },
  };
}

/**
 * `SET` expressions for a claim upsert: take the row (applied = 1, new expiry)
 * only when the existing claim has expired; otherwise mark applied = 0.
 */
export function claimSql(
  cols: CounterColumnRefs,
  now: number,
  until: number,
  sequential = false,
): { applied: string; value: string; expiresAt: string } {
  const expired = `(${cols.expiresAt} IS NOT NULL AND ${cols.expiresAt} <= ${sqlTime(now)})`;
  const taken = sequential ? `${cols.applied} = 1` : expired;
  return {
    applied: `(CASE WHEN ${expired} THEN 1 ELSE 0 END)`,
    value: "0",
    expiresAt: `(CASE WHEN ${taken} THEN ${sqlTime(until)} ELSE ${cols.expiresAt} END)`,
  };
}

/** The dialects the raw (non-Drizzle) SQL counter core speaks. */
export type SqlCounterDialect = "pg" | "sqlite";

/** The async SQL surface the core needs. */
export interface CounterSqlExecutor {
  /** Run a statement with positional parameters and return its rows. */
  all(sql: string, args: unknown[]): Promise<Array<Record<string, unknown>>>;
}

/** DDL for the counter table in a dialect. */
export function counterTableSql(dialect: SqlCounterDialect, table: string): string {
  return dialect === "pg"
    ? `CREATE TABLE IF NOT EXISTS ${table} (key text COLLATE "C" PRIMARY KEY, value double precision NOT NULL DEFAULT 0, applied double precision NOT NULL DEFAULT 0, expires_at bigint)`
    : `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value REAL NOT NULL DEFAULT 0, applied REAL NOT NULL DEFAULT 0, expires_at INTEGER)`;
}

/** Options for {@link sqlCounterStore}. */
export interface SqlCounterStoreConfig {
  dialect: SqlCounterDialect;
  /** A validated, unquoted table identifier. */
  table: string;
  /** Resolve the executor (lazy connect + DDL). */
  exec: () => Promise<CounterSqlExecutor>;
  /** Clock (unix ms). */
  now: () => number;
}

/** A {@link CounterStore} with `keys` and a sweep of expired rows. */
export interface SqlCounterStore extends CounterStore {
  keys(prefix: string): Promise<string[]>;
  /** Delete every expired counter and claim row; resolves to the number removed. */
  purgeExpired(): Promise<number>;
}

/** Build a {@link CounterStore} over a Postgres- or SQLite-dialect executor. */
export function sqlCounterStore(config: SqlCounterStoreConfig): SqlCounterStore {
  const { dialect, table, exec, now } = config;
  const ph = (i: number): string => (dialect === "pg" ? `$${i}` : "?");
  const list = (n: number, from = 1): string =>
    Array.from({ length: n }, (_, i) => ph(from + i)).join(", ");
  const cols: CounterColumnRefs = {
    value: `${table}.value`,
    applied: `${table}.applied`,
    expiresAt: `${table}.expires_at`,
  };
  const live = (t: number) => `(expires_at IS NULL OR expires_at > ${sqlTime(t)})`;

  return {
    async get(keys) {
      if (keys.length === 0) return [];
      const db = await exec();
      const rows = await db.all(
        `SELECT key, value FROM ${table} WHERE key IN (${list(keys.length)}) AND ${live(now())}`,
        [...keys],
      );
      const byKey = new Map(rows.map((r) => [String(r.key), Number(r.value)]));
      return keys.map((k) => byKey.get(k) ?? 0);
    },

    async add(key, amount, options = {}) {
      const q = counterAddSql(cols, amount, options, now());
      const db = await exec();
      const rows = await db.all(
        `INSERT INTO ${table} (key, value, applied, expires_at)
         VALUES (${ph(1)}, ${sqlNumber(q.insert.value)}, ${sqlNumber(q.insert.applied)}, ${sqlTime(q.insert.expiresAt ?? undefined)})
         ON CONFLICT (key) DO UPDATE SET applied = ${q.set.applied}, value = ${q.set.value}, expires_at = ${q.set.expiresAt}
         RETURNING value, applied`,
        [key],
      );
      const row = rows[0]!;
      return { applied: Number(row.applied), value: Number(row.value) };
    },

    async set(key, value, options = {}) {
      const db = await exec();
      await db.all(
        `INSERT INTO ${table} (key, value, applied, expires_at)
         VALUES (${ph(1)}, ${sqlNumber(value)}, 0, ${sqlTime(options.expiresAt)})
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, applied = 0, expires_at = excluded.expires_at`,
        [key],
      );
    },

    async claim(key, ttlMs) {
      const t = now();
      const s = claimSql(cols, t, t + ttlMs);
      const db = await exec();
      const rows = await db.all(
        `INSERT INTO ${table} (key, value, applied, expires_at)
         VALUES (${ph(1)}, 0, 1, ${sqlTime(t + ttlMs)})
         ON CONFLICT (key) DO UPDATE SET applied = ${s.applied}, value = ${s.value}, expires_at = ${s.expiresAt}
         RETURNING applied`,
        [CLAIM_PREFIX + key],
      );
      return Number(rows[0]?.applied) === 1;
    },

    async release(key) {
      const db = await exec();
      await db.all(`DELETE FROM ${table} WHERE key = ${ph(1)}`, [CLAIM_PREFIX + key]);
    },

    async delete(keys) {
      if (keys.length === 0) return;
      const db = await exec();
      await db.all(`DELETE FROM ${table} WHERE key IN (${list(keys.length)})`, [...keys]);
    },

    async keys(prefix) {
      const db = await exec();
      const match = dialect === "pg" ? `key LIKE ${ph(1)} ESCAPE '!'` : `key GLOB ${ph(1)}`;
      const pattern = dialect === "pg" ? `${escapeLike(prefix)}%` : `${escapeGlob(prefix)}*`;
      const rows = await db.all(
        `SELECT key FROM ${table} WHERE ${match} AND value <> 0 AND ${live(now())}`,
        [pattern],
      );
      return rows
        .map((r) => String(r.key))
        .filter((k) => k.startsWith(prefix) && !k.startsWith(CLAIM_PREFIX));
    },

    async purgeExpired() {
      const db = await exec();
      const rows = await db.all(
        `DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ${sqlTime(now())} RETURNING key`,
        [],
      );
      return rows.length;
    },
  };
}
