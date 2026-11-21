/**
 * Usage windows (ADR 0014). Calendar windows are UTC; `billing_period` follows
 * the entitled base subscription's period, or monthly windows anchored on a
 * fallback date (Stripe-style day clamping). A reset is just a new period key —
 * nothing is ever deleted on a schedule.
 *
 * @module
 */

import type { ResetInterval } from "./catalog.ts";
import type { UsagePeriod } from "./schema.ts";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (ms: number) => new Date(ms).toISOString();

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** `anchor` shifted by `months`, with the day clamped to the target month's length. */
export function addMonthsClamped(anchor: number, months: number): number {
  const d = new Date(anchor);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month));
  return Date.UTC(
    year,
    month,
    day,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** The monthly window anchored on `anchor` that contains `now`. */
export function anchoredMonth(anchor: number, now: number): { start: number; end: number } {
  const a = new Date(anchor);
  const n = new Date(now);
  let k = (n.getUTCFullYear() - a.getUTCFullYear()) * 12 + (n.getUTCMonth() - a.getUTCMonth());
  let start = addMonthsClamped(anchor, k);
  while (start > now) start = addMonthsClamped(anchor, --k);
  let end = addMonthsClamped(anchor, k + 1);
  while (end <= now) {
    start = end;
    end = addMonthsClamped(anchor, ++k + 1);
  }
  return { start, end };
}

/** Billing-period inputs for {@link currentPeriod}. */
export interface PeriodAnchor {
  /** The base subscription's current period (ISO). */
  periodStart?: string;
  periodEnd?: string;
  /** Fallback anchor (ISO), e.g. the customer's `createdAt`. */
  anchor?: string;
}

/**
 * The usage window for `reset` at `now`.
 *
 * @example
 * ```ts
 * currentPeriod("month", Date.parse("2026-11-20T10:00:00Z"));
 * // { key: "m:2026-11", start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" }
 * ```
 */
export function currentPeriod(
  reset: ResetInterval,
  now: number,
  anchor: PeriodAnchor = {},
): UsagePeriod {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (reset) {
    case "never":
      return { key: "all", start: null, end: null };
    case "day": {
      const start = Date.UTC(y, m, d.getUTCDate());
      return {
        key: `d:${y}-${pad(m + 1)}-${pad(d.getUTCDate())}`,
        start: iso(start),
        end: iso(start + DAY),
      };
    }
    case "week": {
      const midnight = Date.UTC(y, m, d.getUTCDate());
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      const start = midnight - dow * DAY;
      const s = new Date(start);
      return {
        key: `w:${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`,
        start: iso(start),
        end: iso(start + 7 * DAY),
      };
    }
    case "month":
      return {
        key: `m:${y}-${pad(m + 1)}`,
        start: iso(Date.UTC(y, m, 1)),
        end: iso(Date.UTC(y, m + 1, 1)),
      };
    case "quarter": {
      const q = Math.floor(m / 3);
      return {
        key: `q:${y}-Q${q + 1}`,
        start: iso(Date.UTC(y, q * 3, 1)),
        end: iso(Date.UTC(y, q * 3 + 3, 1)),
      };
    }
    case "year":
      return { key: `y:${y}`, start: iso(Date.UTC(y, 0, 1)), end: iso(Date.UTC(y + 1, 0, 1)) };
    case "billing_period": {
      const ps = anchor.periodStart ? Date.parse(anchor.periodStart) : NaN;
      const pe = anchor.periodEnd ? Date.parse(anchor.periodEnd) : NaN;
      if (Number.isFinite(ps) && Number.isFinite(pe) && ps <= now && now < pe) {
        return { key: `bp:${iso(ps)}`, start: iso(ps), end: iso(pe) };
      }
      // Period data is stale (renewal webhook pending) or absent: roll monthly
      // from the subscription start, else from the fallback anchor.
      const base = Number.isFinite(ps)
        ? ps
        : anchor.anchor
          ? Date.parse(anchor.anchor)
          : Date.UTC(y, m, 1);
      const w = anchoredMonth(base, now);
      return { key: `bp:${iso(w.start)}`, start: iso(w.start), end: iso(w.end) };
    }
  }
}
