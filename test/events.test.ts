import { describe, expect, it, vi } from "vitest";
import { defaultEventErrorReporter, emit, type UsageEvent } from "../src/events.ts";
import { defaultHookErrorReporter } from "../src/hooks/contract.ts";

const event = {
  customer: "c",
  feature: "f",
  amount: 1,
  source: "consume",
  at: "x",
} as unknown as UsageEvent;

describe("emit", () => {
  it("ignores a missing listener and reports sync + async errors", async () => {
    emit(undefined, event);
    const errors: unknown[] = [];
    emit(
      () => {
        throw new Error("sync");
      },
      event,
      (e) => errors.push(e),
    );
    emit(
      async () => {
        throw new Error("async");
      },
      event,
      (e) => errors.push(e),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.map((e) => (e as Error).message)).toEqual(["sync", "async"]);
  });

  it("default reporters warn and never throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    defaultEventErrorReporter(new Error("x"), event);
    defaultHookErrorReporter(new Error("y"), {
      type: "usage.reset",
      customer: "c",
      feature: "f",
      actor: null,
      at: "x",
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain("[@xtandard/entitlements]");
    warn.mockRestore();
  });
});
