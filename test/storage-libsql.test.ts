/**
 * libSQL adapter against a real `@libsql/client` (`:memory:` / local file —
 * no Turso credentials needed). Runs under Node in vitest.
 */
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";
import { createLibsqlStorage, type LibsqlEntitlementsStorage } from "../src/storage/libsql.ts";
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

runStorageContractTests("libsql (:memory:)", make, {
  t: { describe, test, expect },
  capabilities: { compareAndSwap: true, watch: false },
});

describe("libsql storage specifics", () => {
  test("defaults to the xtandard_entitlements_kv table", async () => {
    const client = createClient({ url: ":memory:" });
    const storage = createLibsqlStorage({ client });
    await storage.setItem("ent/k", { b: 1, a: 2 });
    const { rows } = await client.execute("SELECT key, value FROM xtandard_entitlements_kv");
    expect(rows.map((r) => [r.key, r.value])).toEqual([["ent/k", '{"a":2,"b":1}']]);
    storage.close(); // borrowed: does not close the client
    expect((await client.execute("SELECT 1 AS one")).rows[0]?.one).toBe(1);
    client.close();
  });

  test("rejects unsafe table names", () => {
    expect(() => createLibsqlStorage({ url: ":memory:", table: "bad; drop" })).toThrow();
  });

  test("requires a client or url, and retries after a failed connect", async () => {
    const storage = createLibsqlStorage({});
    const message = /@xtandard\/entitlements\/storage\/libsql.*client.*or.*url/i;
    await expect(storage.getItem("k")).rejects.toThrow(message);
    await expect(storage.getItem("k")).rejects.toThrow(message);
  });
});
