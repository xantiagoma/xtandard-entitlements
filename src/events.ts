/**
 * Runtime taps (fire-and-forget, off the decision path): `onUsage` for every
 * successful consume / settle / release, `onThreshold` once per period when
 * usage crosses a configured ratio (ADR 0005). Listener errors are reported,
 * never thrown.
 *
 * @module
 */

import type { CheckResult } from "./schema.ts";

/** One usage change. `amount` is negative for releases / refunds. */
export interface UsageEvent {
  customer: string;
  feature: string;
  amount: number;
  /** `"consume"`, `"reserve"`, `"settle"`, `"release"`, `"set"`. */
  source: "consume" | "reserve" | "settle" | "release" | "set";
  result: CheckResult;
  idempotencyKey?: string;
  reservationId?: string;
  metadata?: Record<string, unknown>;
  at: string;
}

/** Usage crossed `threshold` × limit for the current period. */
export interface ThresholdEvent {
  customer: string;
  feature: string;
  /** e.g. `0.8`, `1`. */
  threshold: number;
  used: number;
  limit: number;
  period: string;
  resetsAt: string | null;
  at: string;
}

/** A usage listener. */
export type UsageListener = (event: UsageEvent) => void | Promise<void>;
/** A threshold listener. */
export type ThresholdListener = (event: ThresholdEvent) => void | Promise<void>;
/** Reports a listener error. */
export type EventErrorReporter = (error: unknown, event: UsageEvent | ThresholdEvent) => void;

/** Default reporter: `console.warn`. */
export const defaultEventErrorReporter: EventErrorReporter = (error) => {
  console.warn("[@xtandard/entitlements] event listener failed:", error);
};

/** Invoke `listener` without awaiting it; sync throws and rejections go to `onError`. */
export function emit<E extends UsageEvent | ThresholdEvent>(
  listener: ((event: E) => void | Promise<void>) | undefined,
  event: E,
  onError: EventErrorReporter = defaultEventErrorReporter,
): void {
  if (!listener) return;
  try {
    const r = listener(event);
    if (r && typeof (r as Promise<void>).then === "function") {
      (r as Promise<void>).then(undefined, (error: unknown) => onError(error, event));
    }
  } catch (error) {
    onError(error, event);
  }
}
