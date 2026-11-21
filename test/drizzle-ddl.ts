/**
 * Test helper: `CREATE TABLE` DDL generated from a Drizzle table factory's own
 * column config, so the factory's column types/collations are what get tested.
 *
 * @module
 */

import { getTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getMysqlTableConfig, type MySqlTable } from "drizzle-orm/mysql-core";

/** `CREATE TABLE` from the factory's own column config, so the factory's types are what get tested. */
export function createTableSql(table: unknown, quote = '"'): string {
  const c =
    quote === "`" ? getMysqlTableConfig(table as MySqlTable) : getTableConfig(table as never);
  const cols = c.columns.map(
    (col) =>
      `${quote}${col.name}${quote} ${col.getSQLType()}${col.notNull ? " NOT NULL" : ""}${
        col.hasDefault ? " DEFAULT 0" : ""
      }${col.primary ? " PRIMARY KEY" : ""}`,
  );
  return `CREATE TABLE ${quote}${c.name}${quote} (${cols.join(", ")})`;
}
