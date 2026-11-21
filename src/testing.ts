/**
 * Test helpers: an in-memory engine with a controllable clock, so tests can
 * cross period boundaries, trial ends and grant expiries deterministically.
 *
 * @example
 * ```ts
 * import { createTestEntitlements } from "@xtandard/entitlements/testing";
 *
 * const { ent, clock } = createTestEntitlements({ catalog, now: "2026-11-30T23:00:00Z" });
 * await ent.consume("org_1", "api_calls", 1000);
 * clock.advance("2h"); // new month → fresh allowance
 * ```
 *
 * @module testing
 */

import type { AnyCatalog } from "./catalog.ts";
import { createMemoryCounterStore } from "./counters/memory.ts";
import { durationToMs, type Duration } from "./duration.ts";
import { createEntitlements, type Entitlements, type EntitlementsOptions } from "./engine.ts";
import type { ThresholdEvent, UsageEvent } from "./events.ts";
import type { AfterEvent } from "./hooks/contract.ts";
import { createMemoryStorage } from "./storage/memory.ts";

/** A controllable clock. */
export interface TestClock {
  /** Current time (unix ms) — pass as `now`. */
  now(): number;
  /** Set the time (ISO string or unix ms). */
  set(at: string | number): void;
  /** Move forward. */
  advance(by: Duration): void;
  /** Current time as ISO. */
  iso(): string;
}

/** Create a {@link TestClock} starting at `start` (default: real now). */
export function createTestClock(start: string | number = Date.now()): TestClock {
  let t = typeof start === "string" ? Date.parse(start) : start;
  return {
    now: () => t,
    set: (at) => {
      t = typeof at === "string" ? Date.parse(at) : at;
    },
    advance: (by) => {
      t += durationToMs(by);
    },
    iso: () => new Date(t).toISOString(),
  };
}

/** Options for {@link createTestEntitlements}. */
export type TestEntitlementsOptions<C extends AnyCatalog> = Omit<EntitlementsOptions<C>, "now"> & {
  /** Start time. Default: real now. */
  now?: string | number;
};

/** What {@link createTestEntitlements} returns. */
export interface TestEntitlements<C extends AnyCatalog> {
  ent: Entitlements<C>;
  clock: TestClock;
  /** Every `onUsage` event, in order. */
  usage: UsageEvent[];
  /** Every `onThreshold` event, in order. */
  thresholds: ThresholdEvent[];
  /** Every `after` hook event, in order. */
  events: AfterEvent[];
}

/**
 * An engine on in-memory storage + counters with a test clock, collecting
 * usage, threshold and hook events. User-supplied listeners still run.
 */
export function createTestEntitlements<const C extends AnyCatalog>(
  options: TestEntitlementsOptions<C>,
): TestEntitlements<C> {
  const clock = createTestClock(options.now);
  const usage: UsageEvent[] = [];
  const thresholds: ThresholdEvent[] = [];
  const events: AfterEvent[] = [];
  const userHooks = options.hooks
    ? Array.isArray(options.hooks)
      ? options.hooks
      : [options.hooks]
    : [];
  const ent = createEntitlements<C>({
    usageSeries: false,
    ...options,
    storage: options.storage ?? createMemoryStorage(),
    counters: options.counters ?? createMemoryCounterStore({ now: clock.now }),
    now: clock.now,
    onUsage: (e) => {
      usage.push(e);
      return options.onUsage?.(e);
    },
    onThreshold: (e) => {
      thresholds.push(e);
      return options.onThreshold?.(e);
    },
    hooks: [...userHooks, { after: (e) => void events.push(e) }],
  });
  return { ent, clock, usage, thresholds, events };
}
