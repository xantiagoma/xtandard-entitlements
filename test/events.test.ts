import { describe, expect, it, vi } from "vitest";
import { defaultEventErrorReporter, emit, type UsageEvent } from "../src/events.ts";
import {
  defaultHookErrorReporter,
  normalizeHooks,
  runAfter,
  runBefore,
} from "../src/hooks/contract.ts";

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
    warn.mockRestore();
  });
});

describe("hooks", () => {
  it("normalizes, runs before sequentially and isolates after errors", async () => {
    expect(normalizeHooks(undefined)).toEqual([]);
    const order: string[] = [];
    const hooks = normalizeHooks([
      { before: async () => void order.push("b1"), after: () => void order.push("a1") },
      {
        before: () => void order.push("b2"),
        after: () => {
          throw new Error("boom");
        },
      },
    ]);
    await runBefore(hooks, { type: "customer.update", customer: "c", actor: null });
    const errors: unknown[] = [];
    await runAfter(
      hooks,
      { type: "usage.reset", customer: "c", feature: "f", actor: null, at: "x" },
      (e) => errors.push(e),
    );
    expect(order).toEqual(["b1", "b2", "a1"]);
    expect(errors).toHaveLength(1);
  });
});
