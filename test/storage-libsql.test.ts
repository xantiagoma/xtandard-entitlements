/**
 * libSQL adapter against a real `@libsql/client` (`:memory:` / local file —
 * no Turso credentials needed). Runs under Node in vitest.
 */
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";
import {
  createLibsqlStorage,
  type LibsqlClientLike,
  type LibsqlEntitlementsStorage,
} from "../src/storage/libsql.ts";
import { runStorageContractTests } from "./storage-contract.ts";

const open: LibsqlEntitlementsStorage[] = [];
const make = (): LibsqlEntitlementsStorage => {
  const storage = createLibsqlStorage({ url: ":memory:" });
  open.push(storage);
  return storage;
};

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

runStorageContractTests("libsql (:memory:)", make, { compareAndSwap: true });

describe("libsql storage specifics", () => {
  test("stores canonical JSON so CAS ignores key order", async () => {
    const client = createClient({ url: ":memory:" });
    const storage = createLibsqlStorage({ client: client as unknown as LibsqlClientLike });
    await storage.setItem("ent/k", { b: 1, a: { d: 1, c: 2 } });
    const { rows } = await client.execute("SELECT value FROM xtandard_entitlements_kv");
    expect(rows[0]?.value).toBe('{"a":{"c":2,"d":1},"b":1}');
    expect(
      await storage.compareAndSwap<unknown>({
        key: "ent/k",
        expected: { a: { c: 2, d: 1 }, b: 1 },
        next: 2,
      }),
    ).toBe(true);
    storage.close(); // borrowed: does not close the client
    expect((await client.execute("SELECT 1 AS one")).rows[0]?.one).toBe(1);
    client.close();
  });

  test("rejects unsafe table names", () => {
    expect(() => createLibsqlStorage({ url: ":memory:", table: "bad; drop" })).toThrow();
  });

  test("requires a client or url, and retries after a failed connect", async () => {
    const storage = createLibsqlStorage({});
    await expect(storage.getItem("k")).rejects.toThrow(/client.*or.*url/i);
    await expect(storage.getItem("k")).rejects.toThrow(/client.*or.*url/i);
  });
});
