// Runs under the Bun runtime (bun test): the engine and catalog work without Node shims.
import { expect, test } from "bun:test";
import { createEntitlements } from "../src/engine.ts";
import { catalog } from "./fixtures.ts";

test("engine runs under Bun", async () => {
  const ent = createEntitlements({ catalog, usageSeries: false });
  await ent.subscribe("org", { plan: "pro" });
  expect((await ent.consume("org", "api_calls", 10)).remaining).toBe(99_990);
  expect((await ent.check("org", "export_pdf")).allowed).toBe(true);
});
