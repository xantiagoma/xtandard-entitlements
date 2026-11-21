/**
 * The SQLite-dialect key/value core shared by the `bun:sqlite` and libSQL
 * adapters. Internal — import {@link ./sqlite.createSqliteStorage} or
 * {@link ./libsql.createLibsqlStorage}.
 *
 * - Values are stored as **canonical JSON** text (object keys sorted), so
 *   `compareAndSwap` is a single `UPDATE … WHERE key = ? AND value = ?`: two
 *   structurally equal values always serialize to the same text.
 * - `getKeys` uses `GLOB` (case-sensitive; SQLite's `LIKE` folds ASCII case)
 *   with the prefix's glob metacharacters escaped.
 *
 * @module
 */

import type { CompareAndSwapEntitlementsStorage } from "./contract.ts";
import { canonicalJson, escapeGlob } from "./util.ts";

/** One row returned by an executor. */
export type SqliteRow = Record<string, unknown>;

/** The tiny async SQL surface the core needs (positional `?` parameters). */
export interface SqliteExecutor {
  /** Run a statement and return its rows (empty for statements without `RETURNING`). */
  all(sql: string, args: unknown[]): Promise<SqliteRow[]>;
}

/** The DDL for the KV table (`key TEXT PRIMARY KEY, value TEXT NOT NULL`). */
export const sqliteKvSchema = (table: string): string =>
  `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

/**
 * Build a compare-and-swap capable storage over a SQLite-dialect executor.
 * `exec` resolves the executor before every operation (lazy connect + DDL).
 */
export function sqliteKvStorage(
  table: string,
  exec: () => Promise<SqliteExecutor>,
): CompareAndSwapEntitlementsStorage {
  return {
    async getItem<T>(key: string): Promise<T | null> {
      const rows = await (await exec()).all(`SELECT value FROM ${table} WHERE key = ?`, [key]);
      const value = rows[0]?.value;
      return typeof value === "string" ? (JSON.parse(value) as T) : null;
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      await (
        await exec()
      ).all(
        `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, canonicalJson(value)],
      );
    },

    async removeItem(key: string): Promise<void> {
      await (await exec()).all(`DELETE FROM ${table} WHERE key = ?`, [key]);
    },

    async getKeys(prefix: string): Promise<string[]> {
      const rows = await (
        await exec()
      ).all(`SELECT key FROM ${table} WHERE key GLOB ?`, [`${escapeGlob(prefix)}*`]);
      // GLOB is already case-sensitive; keep only exact prefix matches regardless.
      return rows.map((r) => String(r.key)).filter((key) => key.startsWith(prefix));
    },

    async compareAndSwap<T>(input: { key: string; expected: T | null; next: T }): Promise<boolean> {
      const db = await exec();
      const next = canonicalJson(input.next);
      const rows =
        input.expected === null
          ? await db.all(
              `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING RETURNING key`,
              [input.key, next],
            )
          : await db.all(
              `UPDATE ${table} SET value = ? WHERE key = ? AND value = ? RETURNING key`,
              [next, input.key, canonicalJson(input.expected)],
            );
      return rows.length === 1;
    },
  };
}
