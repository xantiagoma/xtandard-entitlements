import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildCounters, buildStorage, loadCatalog, parseArgs, run } from "../src/cli.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

let out = "";
let err = "";
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  process.env.STORAGE_DRIVER = "memory";
  delete process.env.COUNTERS_DRIVER;
  delete process.env.CATALOG_PATH;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.STORAGE_DRIVER;
});

const CATALOG = "test/fixtures.ts";
const cli = (...argv: string[]) => run([...argv, "--catalog", CATALOG]);
const json = <T = Record<string, unknown>>() => JSON.parse(out) as T;

describe("cli basics", () => {
  test("help / version / unknown command", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(out).toContain("xtandard-entitlements v");
    expect(out).toContain("pricing [--include-hidden]");
    out = "";
    expect(await run([])).toBe(1);
    expect(out).toContain("Commands:");
    out = "";
    expect(await run(["--version"])).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
    expect(await run(["nope"])).toBe(1);
    expect(err).toContain("Unknown command: nope");
  });

  test("a catalog is required and must export one", async () => {
    expect(await run(["pricing"])).toBe(1);
    expect(err).toContain("Missing --catalog");
    const dir = mkdtempSync(join(tmpdir(), "xte-cli-"));
    const bad = join(dir, "bad.mjs");
    writeFileSync(bad, "export const nothing = 1;\n");
    expect(await run(["pricing", "--catalog", bad])).toBe(1);
    expect(err).toContain("does not export a catalog");
  });

  test("CATALOG_PATH works like --catalog; default exports are accepted", async () => {
    process.env.CATALOG_PATH = CATALOG;
    expect(await run(["pricing"])).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "xte-cli-"));
    const file = join(dir, "default.mjs");
    writeFileSync(
      file,
      `import { catalog } from ${JSON.stringify(join(process.cwd(), "test/fixtures.ts"))};\nexport default { catalog };\n`,
    );
    const loaded = await loadCatalog(file);
    expect(loaded.featureKeys).toContain("api_calls");
  });

  test("parseArgs handles --k v, --k=v and boolean flags", () => {
    expect(parseArgs(["check", "--customer", "c", "--amount=5", "--json", "--x"])).toEqual({
      _: ["check"],
      flags: { customer: "c", amount: "5", json: true, x: true },
    });
  });
});

describe("cli commands", () => {
  test("pricing prints the public table (or everything with --include-hidden)", async () => {
    expect(await cli("pricing")).toBe(0);
    expect(json<{ plans: Array<{ key: string }> }>().plans.map((p) => p.key)).toEqual([
      "free",
      "pro",
      "business",
    ]);
    out = "";
    await cli("pricing", "--include-hidden");
    expect(json<{ plans: unknown[] }>().plans).toHaveLength(4);
  });

  test("check exits 0 when allowed, 2 when denied", async () => {
    expect(await cli("check", "--customer", "org_1", "--feature", "seats", "--amount", "2")).toBe(
      0,
    );
    expect(json()).toMatchObject({ allowed: true, remaining: 3 });
    out = "";
    expect(await cli("check", "--customer", "org_1", "--feature", "sso")).toBe(2);
    expect(json()).toMatchObject({ allowed: false, denial: "payment_required" });
  });

  test("consume (with an idempotency key) and refusals", async () => {
    expect(
      await cli(
        "consume",
        "--customer",
        "c",
        "--feature",
        "exports",
        "--amount",
        "5",
        "--idempotency-key",
        "k",
      ),
    ).toBe(0);
    out = "";
    expect(await cli("consume", "--customer", "c", "--feature", "exports", "--amount", "9")).toBe(
      2,
    );
  });

  test("grant / override / subscribe print the created records", async () => {
    expect(
      await cli(
        "grant",
        "--customer",
        "c",
        "--feature",
        "api_calls",
        "--amount",
        "50",
        "--reason",
        "goodwill",
        "--expires-at",
        "2027-01-01T00:00:00Z",
        "--recurring",
        "false",
      ),
    ).toBe(0);
    expect(json()).toMatchObject({
      feature: "api_calls",
      amount: 50,
      reason: "goodwill",
      actor: { id: "cli", type: "system" },
    });
    out = "";
    expect(
      await cli(
        "override",
        "--customer",
        "c",
        "--feature",
        "api_calls",
        "--limit",
        "unlimited",
        "--expires-at",
        "2027-01-01T00:00:00Z",
        "--reason",
        "vip",
      ),
    ).toBe(0);
    expect(json()).toMatchObject({ feature: "api_calls", limit: null });
    out = "";
    expect(
      await cli("override", "--customer", "c", "--feature", "support", "--value", '"priority"'),
    ).toBe(0);
    expect(json()).toMatchObject({ value: "priority" });
    out = "";
    expect(await cli("override", "--customer", "c", "--feature", "sso", "--enabled", "true")).toBe(
      0,
    );
    out = "";
    expect(await cli("override", "--customer", "c", "--feature", "seats", "--limit", "20")).toBe(0);
    expect(json()).toMatchObject({ limit: 20 });
    out = "";
    expect(
      await cli(
        "subscribe",
        "--customer",
        "c",
        "--plan",
        "pro",
        "--version",
        "1",
        "--quantity",
        "2",
        "--status",
        "trialing",
        "--trial-ends-at",
        "2026-12-01T00:00:00Z",
      ),
    ).toBe(0);
    expect(json()).toMatchObject({ plan: "pro", version: 1, quantity: 2, status: "trialing" });
  });

  test("usage errors exit 1 with the usage line", async () => {
    expect(await cli("check", "--customer", "c")).toBe(1);
    expect(err).toContain("Missing --feature");
    err = "";
    expect(await cli("grant", "--customer", "c", "--feature", "api_calls", "--amount", "x")).toBe(
      1,
    );
    expect(err).toContain("--amount must be a number");
    err = "";
    expect(await cli("override", "--customer", "c", "--feature", "sso", "--enabled", "maybe")).toBe(
      1,
    );
    expect(err).toContain("true or false");
    err = "";
    expect(await cli("override", "--customer", "c", "--feature", "support", "--value", "{x")).toBe(
      1,
    );
    expect(err).toContain("Invalid --value");
    err = "";
    expect(await cli("grant", "--customer", "c", "--feature", "export_pdf", "--amount", "1")).toBe(
      1,
    );
    expect(err).toContain("Error: Grants apply to numeric features");
  });

  test("customers (text and --json) and sweep", async () => {
    expect(await cli("customers")).toBe(0);
    expect(out).toBe("No customers.\n");
    out = "";
    expect(await cli("customers", "--json", "--search", "x", "--limit", "5")).toBe(0);
    expect(json()).toEqual({ customers: [] });
    out = "";
    expect(await cli("sweep")).toBe(0);
    expect(json()).toEqual({ released: 0 });
  });

  test("driver selection errors", async () => {
    expect(await cli("sweep", "--storage", "floppy")).toBe(1);
    expect(err).toContain('Unknown storage driver "floppy"');
    err = "";
    expect(await cli("sweep", "--counters", "abacus")).toBe(1);
    expect(err).toContain('Unknown counters driver "abacus"');
  });
});

describe("cli drivers", () => {
  test("memory storage + default kv counters (CAS); explicit memory counters", async () => {
    const storage = await buildStorage("memory");
    expect((await buildCounters(undefined, storage)).driver).toBe("kv");
    expect((await buildCounters("memory", storage)).driver).toBe("memory");
  });

  test("storage without compare-and-swap falls back to memory counters with a warning", async () => {
    const { compareAndSwap: _cas, ...plain } = createMemoryStorage();
    const { driver } = await buildCounters(undefined, plain);
    expect(driver).toBe("memory");
    expect(err).toContain("usage is not persisted");
  });
});
