import { describe, expect, it } from "vitest";
import { addMonthsClamped, anchoredMonth, currentPeriod } from "../src/periods.ts";

const at = (s: string) => Date.parse(s);

describe("currentPeriod", () => {
  it("calendar windows in UTC", () => {
    const now = at("2026-11-20T23:30:00Z");
    expect(currentPeriod("day", now)).toEqual({
      key: "d:2026-11-20",
      start: "2026-11-20T00:00:00.000Z",
      end: "2026-11-21T00:00:00.000Z",
    });
    expect(currentPeriod("week", now)).toEqual({
      key: "w:2026-11-16",
      start: "2026-11-16T00:00:00.000Z",
      end: "2026-11-23T00:00:00.000Z",
    });
    expect(currentPeriod("month", now)).toEqual({
      key: "m:2026-11",
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-12-01T00:00:00.000Z",
    });
    expect(currentPeriod("quarter", now)).toEqual({
      key: "q:2026-Q4",
      start: "2026-10-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
    expect(currentPeriod("year", now)).toEqual({
      key: "y:2026",
      start: "2026-01-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
    expect(currentPeriod("never", now)).toEqual({ key: "all", start: null, end: null });
  });

  it("week starts Monday (Sunday belongs to the previous week)", () => {
    expect(currentPeriod("week", at("2026-11-22T12:00:00Z")).key).toBe("w:2026-11-16");
    expect(currentPeriod("week", at("2026-11-23T00:00:00Z")).key).toBe("w:2026-11-23");
  });

  it("billing_period uses the subscription period when current", () => {
    const p = currentPeriod("billing_period", at("2026-11-20T00:00:00Z"), {
      periodStart: "2026-11-14T08:00:00Z",
      periodEnd: "2026-12-14T08:00:00Z",
    });
    expect(p).toEqual({
      key: "bp:2026-11-14T08:00:00.000Z",
      start: "2026-11-14T08:00:00.000Z",
      end: "2026-12-14T08:00:00.000Z",
    });
  });

  it("billing_period rolls monthly from a stale period or the anchor", () => {
    const stale = currentPeriod("billing_period", at("2027-01-20T00:00:00Z"), {
      periodStart: "2026-11-14T08:00:00Z",
      periodEnd: "2026-12-14T08:00:00Z",
    });
    expect(stale.start).toBe("2027-01-14T08:00:00.000Z");
    const anchored = currentPeriod("billing_period", at("2026-11-20T00:00:00Z"), {
      anchor: "2026-01-31T00:00:00Z",
    });
    expect(anchored).toMatchObject({
      start: "2026-10-31T00:00:00.000Z",
      end: "2026-11-30T00:00:00.000Z",
    });
    expect(currentPeriod("billing_period", at("2026-11-20T00:00:00Z")).start).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });
});

describe("month arithmetic", () => {
  it("clamps the day to the target month", () => {
    expect(new Date(addMonthsClamped(at("2026-01-31T10:00:00Z"), 1)).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(new Date(addMonthsClamped(at("2028-01-31T10:00:00Z"), 1)).toISOString()).toBe(
      "2028-02-29T10:00:00.000Z",
    );
    expect(new Date(addMonthsClamped(at("2026-03-31T00:00:00Z"), -1)).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(new Date(addMonthsClamped(at("2026-11-15T00:00:00Z"), 14)).toISOString()).toBe(
      "2028-01-15T00:00:00.000Z",
    );
  });

  it("anchoredMonth finds the window containing now", () => {
    const w = anchoredMonth(at("2026-01-31T00:00:00Z"), at("2026-03-30T12:00:00Z"));
    expect(new Date(w.start).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(new Date(w.end).toISOString()).toBe("2026-03-31T00:00:00.000Z");
    const exact = anchoredMonth(at("2026-01-15T00:00:00Z"), at("2026-02-15T00:00:00Z"));
    expect(new Date(exact.start).toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });
});
