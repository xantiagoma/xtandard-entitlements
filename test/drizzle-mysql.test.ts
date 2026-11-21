/**
 * Live MySQL suites for the Drizzle storage and counter adapters
 * (`drizzle-orm/mysql2`): the full storage contract — case/accent-distinct keys
 * (utf8mb4_bin) and LIKE metacharacters (`ESCAPE '!'`) — and the counter
 * contract incl. concurrency. Skips unless `MYSQL_URL` is set (CI provides a
 * `mysql:8` service). Each run works in its own database, dropped afterwards.
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { afterAll, describe, vi } from "vitest";
import { createDrizzleCounterStore } from "../src/counters/drizzle.ts";
import { mysqlCountersTable, mysqlEntitlementsTable } from "../src/drizzle/mysql.ts";
import { createDrizzleStorage } from "../src/storage/drizzle.ts";
import { runCounterContractTests } from "./counter-contract.ts";
import { createTableSql } from "./drizzle-ddl.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const MYSQL_URL = process.env.MYSQL_URL;

// Live round-trips are slow on a loaded machine.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const dbName = `xtandard_entitlements_test_${Date.now()}`;
let pool: mysql.Pool | undefined;

async function getPool(): Promise<mysql.Pool> {
  if (pool) return pool;
  const admin = await mysql.createConnection({ uri: MYSQL_URL! });
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await admin.end();
  pool = mysql.createPool({ uri: MYSQL_URL!, database: dbName, connectionLimit: 16 });
  return pool;
}

let n = 0;
describe.skipIf(!MYSQL_URL)("drizzle mysql (live)", () => {
  runStorageContractTests(
    "drizzle (mysql2)",
    async () => {
      const p = await getPool();
      const table = mysqlEntitlementsTable(`kv_${n++}`);
      await p.query(createTableSql(table, "`"));
      return createDrizzleStorage({ db: drizzle(p as never), table });
    },
    { compareAndSwap: true },
  );

  runCounterContractTests(
    "drizzle counters (mysql2)",
    async () => {
      const p = await getPool();
      const table = mysqlCountersTable(`counters_${n++}`);
      await p.query(createTableSql(table, "`"));
      return createDrizzleCounterStore({ db: drizzle(p as never), table });
    },
    { keys: true, concurrency: 30 },
  );

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await pool.end();
  });
});
