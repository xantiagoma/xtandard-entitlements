/**
 * One scenario, every port: the same engine calls over different state
 * storage + counter store pairs — the engine never knows which is which.
 *
 *   bun run demo     # or, from the repo root: bun run examples:storage-drivers --demo
 *
 * Always runs: memory · file + kv-CAS counters · SQLite (bun:sqlite) · libSQL (file) ·
 * Postgres (PGlite, in-process). Set REDIS_URL to add Redis.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { PGlite } from "@electric-sql/pglite";
import {
  createEntitlements,
  type CountersOption,
  type EntitlementsStorage,
} from "@xtandard/entitlements";
import { createKvCounterStore } from "@xtandard/entitlements/counters/kv";
import { createLibsqlCounterStore } from "@xtandard/entitlements/counters/libsql";
import { createMemoryCounterStore } from "@xtandard/entitlements/counters/memory";
import { createPostgresCounterStore } from "@xtandard/entitlements/counters/postgres";
import { createRedisCounterStore } from "@xtandard/entitlements/counters/redis";
import { createSqliteCounterStore } from "@xtandard/entitlements/counters/sqlite";
import { createFileStorage } from "@xtandard/entitlements/storage/file";
import { createLibsqlStorage } from "@xtandard/entitlements/storage/libsql";
import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
import { createPostgresStorage } from "@xtandard/entitlements/storage/postgres";
import { createRedisStorage } from "@xtandard/entitlements/storage/redis";
import { createSqliteStorage } from "@xtandard/entitlements/storage/sqlite";
import { catalog } from "../../shared/catalog.ts";
import { equal, info, runDemo, step } from "../../shared/demo-kit.ts";

/** A storage + counters pair, and whether a second engine over it sees the first one's data. */
interface Driver {
  name: string;
  storage: EntitlementsStorage;
  counters: CountersOption;
  persistent: boolean;
  close?: () => Promise<void> | void;
}

const dir = mkdtempSync(join(tmpdir(), "xtandard-entitlements-drivers-"));

function drivers(): Driver[] {
  const list: Driver[] = [];

  list.push({
    name: "memory + memory",
    storage: createMemoryStorage(),
    counters: createMemoryCounterStore(),
    persistent: false,
  });

  // Counters on any compare-and-swap storage: one document per counter, a CAS retry loop.
  const file = createFileStorage({ dir: join(dir, "file") });
  list.push({
    name: "file + kv-CAS",
    storage: file,
    counters: createKvCounterStore(file),
    persistent: true,
  });

  // One SQLite database file for both planes (two tables).
  const db = new Database(join(dir, "app.sqlite"));
  list.push({
    name: "sqlite + sqlite",
    storage: createSqliteStorage({ database: db }),
    counters: createSqliteCounterStore({ database: db }),
    persistent: true,
    close: () => db.close(),
  });

  const libsqlUrl = `file:${join(dir, "app.libsql")}`;
  const libsqlStorage = createLibsqlStorage({ url: libsqlUrl });
  const libsqlCounters = createLibsqlCounterStore({ url: libsqlUrl });
  list.push({
    name: "libsql + libsql",
    storage: libsqlStorage,
    counters: libsqlCounters,
    persistent: true,
    close: async () => {
      await libsqlCounters.close();
      await libsqlStorage.close();
    },
  });

  // Real Postgres SQL, in-process (WASM): the same driver as a `pg` Pool.
  const pg = new PGlite();
  list.push({
    name: "postgres (PGlite) + postgres",
    storage: createPostgresStorage({ client: pg }),
    counters: createPostgresCounterStore({ client: pg }),
    persistent: true,
    close: () => pg.close(),
  });

  if (process.env.REDIS_URL) {
    const prefix = `xe-drivers-${Date.now().toString(36)}`;
    const storage = createRedisStorage({ url: process.env.REDIS_URL, prefix });
    const counters = createRedisCounterStore({ url: process.env.REDIS_URL, prefix });
    list.push({
      name: "redis + redis",
      storage,
      counters,
      persistent: true,
      close: async () => {
        await counters.close();
        await storage.close();
      },
    });
  }
  return list;
}

/** The scenario: identical calls, identical answers, whatever the driver. */
async function scenario(d: Driver) {
  const ent = createEntitlements({ catalog, storage: d.storage, counters: d.counters });
  await ent.updateCustomer("org_1", { name: "Driver Test Co." });
  await ent.subscribe("org_1", { plan: "pro" });

  // 50 concurrent seat requests against Pro's 10: the counter's atomic bounded add.
  const seats = await Promise.all(Array.from({ length: 50 }, () => ent.consume("org_1", "seats")));
  // Idempotency claims live in the counter store too.
  await ent.consume("org_1", "api_calls", 5, { idempotencyKey: "req-1" });
  const replay = await ent.consume("org_1", "api_calls", 5, { idempotencyKey: "req-1" });
  // A grant and an override are state-storage writes.
  await ent.grant("org_1", { feature: "ai_credits", amount: 250, reason: "welcome pack" });
  await ent.override("org_1", { feature: "sso", enabled: true, reason: "pilot" });
  const e = await ent.entitlements("org_1");
  await ent.close();

  // A second engine over the same backends (a restart, or another instance).
  let restarted: string | undefined;
  if (d.persistent) {
    const again = createEntitlements({ catalog, storage: d.storage, counters: d.counters });
    const r = await again.entitlements("org_1");
    restarted = `${r.plans[0]?.plan} · ${r.features.seats?.used} seats`;
    await again.close();
  }
  return {
    granted: seats.filter((s) => s.allowed).length,
    duplicate: replay.duplicate === true,
    apiCalls: e.features.api_calls?.used,
    credits: e.features.ai_credits?.limit,
    sso: e.features.sso?.enabled,
    restarted,
  };
}

runDemo("Storage drivers × @xtandard/entitlements", async () => {
  try {
    for (const d of drivers()) {
      step(d.name);
      try {
        const r = await scenario(d);
        equal(r.granted, 10, "50 concurrent seat requests, 10 granted");
        equal([r.duplicate, r.apiCalls], [true, 5], "idempotent replay counted once");
        equal([r.credits, r.sso], [5_000 + 250, true], "grant + override applied");
        if (r.restarted) equal(r.restarted, "pro · 10 seats", "a fresh engine reads it back");
        else info("(in-memory: nothing survives a restart)");
      } finally {
        await d.close?.();
      }
    }
    if (!process.env.REDIS_URL) console.log("\n(set REDIS_URL to include Redis)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
