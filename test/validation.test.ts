import { describe, expect, test } from "vitest";
import { EntitlementsValidationError } from "../src/engine.ts";
import {
  grantSchema,
  InputValidationError,
  overrideSchema,
  parseInput,
  runtimeReserveSchema,
  subscribeSchema,
} from "../src/validation.ts";

describe("parseInput", () => {
  test("returns the typed output", () => {
    expect(parseInput(grantSchema, { feature: "api_calls", amount: 5 })).toEqual({
      feature: "api_calls",
      amount: 5,
    });
    expect(
      parseInput(overrideSchema, { feature: "x", limit: null, value: { a: [1, "b"] } }),
    ).toEqual({ feature: "x", limit: null, value: { a: [1, "b"] } });
    expect(
      parseInput(runtimeReserveSchema, { customer: "c", feature: "f", amount: 1, ttl: "5m" }).ttl,
    ).toBe("5m");
  });

  test("collects every issue with dotted paths", () => {
    const err = (() => {
      try {
        parseInput(subscribeSchema, {
          plan: "",
          version: 1.5,
          trialEndsAt: "tomorrow",
          metadata: { nested: { fn: undefined } },
          extra: 1,
        });
      } catch (e) {
        return e;
      }
    })() as InputValidationError;
    expect(err).toBeInstanceOf(InputValidationError);
    expect(err).toBeInstanceOf(EntitlementsValidationError);
    expect(err.name).toBe("EntitlementsValidationError");
    const paths = err.issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(["plan", "version", "trialEndsAt", "metadata.nested", "extra"]),
    );
    expect(err.message).toMatch(/^Invalid input: /);
    expect(err.issues.find((i) => i.path === "extra")!.message).toBe("unknown field");
  });

  test("root-level issues have an empty path", () => {
    const err = new InputValidationError([{ path: "", message: "expected an object" }]);
    expect(err.message).toBe("Invalid input: expected an object");
    expect(() => parseInput(grantSchema, "nope")).toThrow(InputValidationError);
  });

  test("durations must parse; amounts must be finite and positive where required", () => {
    expect(() =>
      parseInput(runtimeReserveSchema, { customer: "c", feature: "f", amount: 1, ttl: -5 }),
    ).toThrow(/duration/);
    expect(() => parseInput(grantSchema, { feature: "f", amount: 0 })).toThrow(/> 0/);
    expect(() => parseInput(grantSchema, { feature: "f", amount: Infinity })).toThrow(/finite/);
  });
});
