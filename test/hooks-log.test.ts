import { describe, expect, test, vi } from "vitest";
import { createLogHook } from "../src/hooks/log.ts";
import { createTestEntitlements } from "../src/testing.ts";
import { catalog } from "./fixtures.ts";

describe("createLogHook", () => {
  test("logs after events as text by default", async () => {
    const lines: string[] = [];
    const { ent } = createTestEntitlements({
      catalog,
      hooks: createLogHook({ log: (l) => lines.push(l) }),
    });
    await ent.grant("org_1", { feature: "api_calls", amount: 5 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[@xtandard\/entitlements\] after grant\.created org_1 \{/);
  });

  test("json mode emits one object per line; includeBefore logs both phases", async () => {
    const lines: string[] = [];
    const { ent } = createTestEntitlements({
      catalog,
      hooks: createLogHook({ log: (l) => lines.push(l), json: true, includeBefore: true }),
    });
    await ent.override("org_1", { feature: "sso", enabled: true });
    const parsed = lines.map(
      (l) => JSON.parse(l) as { phase: string; type: string; source: string },
    );
    expect(parsed.map((p) => `${p.phase}:${p.type}`)).toEqual([
      "before:override.create",
      "after:override.created",
    ]);
    expect(parsed[0]!.source).toBe("@xtandard/entitlements");
  });

  test("custom format wins; default sink is console.log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ent } = createTestEntitlements({
      catalog,
      hooks: createLogHook({ format: (phase, e) => `${phase}/${e.type}` }),
    });
    await ent.updateCustomer("org_1", { name: "x" });
    expect(spy).toHaveBeenCalledWith("after/customer.updated");
    spy.mockRestore();
  });
});
