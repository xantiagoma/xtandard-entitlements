/**
 * Pure UI helpers — no React, no DOM. Unit-tested in `test/ui-lib.test.ts`
 * (visual behavior is covered by the Playwright e2e suite instead).
 *
 * @module
 */

import type {
  EntitlementSource,
  FeatureUsage,
  NormalizedEntry,
  NormalizedFeature,
  PriceDisplay,
  SubscriptionStatus,
} from "../types.ts";

const DAY_MS = 86_400_000;

/** Absolute date-time, locale-aware. Returns `"—"` for missing/invalid input. */
export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Absolute date, locale-aware (`"Nov 20, 2026"`). `"—"` for missing/invalid input. */
export function formatDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/**
 * Compact relative time: `"just now"`, `"5m ago"`, `"in 2h"`, `"3d ago"`.
 * `now` is injectable for tests; defaults to the current time.
 */
export function relativeTime(iso: string | undefined | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const diff = now - at;
  const abs = Math.abs(diff);
  if (abs < 10_000) return "just now";
  const units: [number, string][] = [
    [1000, "s"],
    [60_000, "m"],
    [3_600_000, "h"],
    [DAY_MS, "d"],
  ];
  let value = Math.round(abs / 1000);
  let unit = "s";
  for (const [ms, label] of units) {
    if (abs >= ms) {
      value = Math.round(abs / ms);
      unit = label;
    }
  }
  return diff >= 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
}

/** Whole days from `now` until `iso` (negative when past); `null` for missing/invalid input. */
export function daysUntil(iso: string | undefined | null, now: number = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.ceil((at - now) / DAY_MS);
}

/** `"Resets in 4d"`, `"Resets in 3h"`, `"Never resets"` (null). */
export function resetsInLabel(iso: string | undefined | null, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return "Never resets";
  const rel = relativeTime(iso, now);
  if (rel === "—") return "Never resets";
  return rel.startsWith("in ") ? `Resets ${rel}` : "Resets now";
}

/** Thousands-separated integer/decimal (`12,400`). */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Short number for tight spaces: `950`, `1.2k`, `48k`, `3.1M`. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  const fmt = (v: number, suffix: string) =>
    `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${suffix}`;
  if (abs >= 1_000_000_000) return fmt(n / 1_000_000_000, "B");
  if (abs >= 1_000_000) return fmt(n / 1_000_000, "M");
  if (abs >= 1_000) return fmt(n / 1_000, "k");
  return formatNumber(n);
}

/** `"$29 / mo"`, `"€290 / yr"`, `"$5 one-time"`, `"Free"` — the first display price. */
export function formatPrice(prices: readonly PriceDisplay[] | undefined): string {
  const price = prices?.[0];
  if (!price) return "Free";
  if (price.label) return price.label;
  if (price.amount === 0) return "Free";
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
    minimumFractionDigits: price.amount % 100 === 0 ? 0 : 2,
  }).format(price.amount / 100);
  switch (price.interval) {
    case "month":
      return `${money} / mo`;
    case "year":
      return `${money} / yr`;
    case "week":
      return `${money} / wk`;
    case "day":
      return `${money} / day`;
    case "one_time":
      return `${money} one-time`;
    default:
      return money;
  }
}

/** Human label for a subscription status. */
export function statusLabel(status: SubscriptionStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "trialing":
      return "Trialing";
    case "past_due":
      return "Past due";
    case "paused":
      return "Paused";
    case "canceled":
      return "Canceled";
    case "incomplete":
      return "Incomplete";
  }
}

/** Tailwind classes for a status badge (flags/webhooks badge tone conventions). */
export function statusTone(status: SubscriptionStatus): string {
  switch (status) {
    case "active":
      return "border-success/30 bg-success/10 text-success";
    case "trialing":
      return "border-info/30 bg-info/10 text-info";
    case "past_due":
      return "border-warning/30 bg-warning/10 text-warning";
    case "incomplete":
      return "border-warning/30 bg-warning/10 text-warning";
    case "paused":
      return "border-border bg-secondary/60 text-muted-foreground";
    case "canceled":
      return "border-destructive/30 bg-destructive/10 text-destructive";
  }
}

/** Every subscription status, in display order. */
export const STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
  "incomplete",
  "paused",
  "canceled",
];

/** Used share of a limit in `[0, ∞)`; `null` when unlimited or not numeric. */
export function usageRatio(
  used: number | undefined,
  limit: number | null | undefined,
): number | null {
  if (limit === null || limit === undefined || used === undefined) return null;
  if (limit <= 0) return used > 0 ? 1 : 0;
  return used / limit;
}

/** Threshold colouring for a usage bar: lime below 75%, amber to 90%, red from 90%. */
export type UsageLevel = "ok" | "warn" | "critical";

/** The {@link UsageLevel} for a used share. */
export function usageLevel(ratio: number | null): UsageLevel {
  if (ratio === null || ratio < 0.75) return "ok";
  if (ratio < 0.9) return "warn";
  return "critical";
}

/** `"seat"`/`"seats"` for a feature and an amount (`""` when unitless). */
export function unitFor(
  feature: Pick<NormalizedFeature, "unit" | "units">,
  amount: number,
): string {
  return amount === 1 ? (feature.unit ?? "") : (feature.units ?? feature.unit ?? "");
}

/** `"1,000 calls"`, `"Unlimited"`, `"—"` for a numeric limit. */
export function limitLabel(
  feature: Pick<NormalizedFeature, "unit" | "units">,
  limit: number | null | undefined,
): string {
  if (limit === undefined) return "—";
  if (limit === null) return "Unlimited";
  const unit = unitFor(feature, limit);
  return unit ? `${formatNumber(limit)} ${unit}` : formatNumber(limit);
}

/** Human label for a reset interval (`"monthly"`, `"never"`). */
export function resetLabel(reset: string | undefined): string {
  switch (reset) {
    case "day":
      return "daily";
    case "week":
      return "weekly";
    case "month":
      return "monthly";
    case "quarter":
      return "quarterly";
    case "year":
      return "yearly";
    case "billing_period":
      return "per billing period";
    case "never":
      return "never";
    default:
      return "—";
  }
}

/** A source chip's label: `"plan pro v2"`, `"grant"`, `"override"`. */
export function sourceLabel(source: EntitlementSource): string {
  switch (source.type) {
    case "plan":
      return source.version !== undefined && source.version > 1
        ? `plan ${source.id} v${source.version}`
        : `plan ${source.id}`;
    case "addon":
      return `add-on ${source.id}`;
    default:
      return source.type;
  }
}

/** Is a feature numeric (has a limit / usage)? */
export function isNumeric(kind: string): boolean {
  return kind === "metered" || kind === "credits" || kind === "capacity";
}

/** Two-letter initials for an avatar (`"Acme Corp"` → `"AC"`, `"org_42"` → `"OR"`). */
export function initials(name: string): string {
  const words = name
    .replace(/[_\-.@]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Convert a `<input type="date">` value (`YYYY-MM-DD`) to an end-of-day UTC ISO string. */
export function dateInputToIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const t = Date.parse(`${value}T23:59:59.000Z`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Parse a user-typed number (`"1,000"`, `" 25 "`); `null` when not a finite number. */
export function parseAmount(value: string): number | null {
  const cleaned = value.replace(/[,_\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Summarise a feature's current state for a table cell or card. */
export function featureSummary(
  feature: Pick<NormalizedFeature, "unit" | "units">,
  usage: Pick<FeatureUsage, "kind" | "enabled" | "limit" | "used" | "value">,
): string {
  if (usage.kind === "boolean") return usage.enabled ? "Enabled" : "Not included";
  if (usage.kind === "value") {
    return typeof usage.value === "string" ? usage.value : JSON.stringify(usage.value ?? null);
  }
  if (!usage.enabled) return "Not included";
  const used = formatNumber(usage.used ?? 0);
  return usage.limit === null || usage.limit === undefined
    ? `${used} used · Unlimited`
    : `${used} / ${limitLabel(feature, usage.limit)}`;
}

/** The daily maximum of a series, rounded up to a "nice" axis bound (1, 2, 2.5, 5 × 10ⁿ). */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * base >= max) return step * base;
  }
  return 10 * base;
}

/** The display label of a plan's entry for one feature (catalog matrix cells). */
export function entryLabel(
  feature: Pick<NormalizedFeature, "kind" | "unit" | "units" | "reset" | "default">,
  entry: NormalizedEntry | undefined,
): { label: string; included: boolean; detail?: string } {
  if (feature.kind === "boolean") {
    const on = entry?.kind === "boolean" && entry.enabled;
    return { label: on ? "✓" : "—", included: on };
  }
  if (feature.kind === "value") {
    const value = entry?.kind === "value" ? entry.value : (feature.default ?? null);
    return {
      label:
        typeof value === "string"
          ? value
          : typeof value === "number"
            ? formatNumber(value)
            : JSON.stringify(value),
      included: true,
      ...(entry?.kind === "value" ? {} : { detail: "default" }),
    };
  }
  if (!entry || entry.kind === "boolean" || entry.kind === "value" || !entry.included) {
    return { label: "—", included: false };
  }
  const reset = entry.reset ?? feature.reset;
  const details: string[] = [];
  if (reset && reset !== "never" && feature.kind !== "capacity") details.push(resetLabel(reset));
  if (entry.overage === "allow") {
    details.push(
      entry.overageLimit === null
        ? "overage allowed"
        : `overage to ${formatNumber(entry.overageLimit)}`,
    );
  }
  return {
    label: limitLabel(feature, entry.limit),
    included: true,
    ...(details.length ? { detail: details.join(" · ") } : {}),
  };
}

/** A plan's first display price normalized to cents per month (`0` when free / no price). */
export function monthlyCents(prices: readonly PriceDisplay[] | undefined): number {
  const p = prices?.[0];
  if (!p) return 0;
  switch (p.interval) {
    case "year":
      return p.amount / 12;
    case "week":
      return (p.amount * 52) / 12;
    case "day":
      return p.amount * 30;
    default:
      return p.amount;
  }
}

/**
 * Whether moving from `current` to `target` is an upgrade or a downgrade:
 * by monthly price, then by position in the pricing table.
 */
export function planDirection(
  plans: ReadonlyArray<{ key: string; price: PriceDisplay[] }>,
  current: string | undefined,
  target: string,
): "current" | "upgrade" | "downgrade" {
  if (current === target) return "current";
  const from = plans.findIndex((p) => p.key === current);
  const to = plans.findIndex((p) => p.key === target);
  if (from === -1) return "upgrade";
  const diff = monthlyCents(plans[to]?.price) - monthlyCents(plans[from]?.price);
  if (diff !== 0) return diff > 0 ? "upgrade" : "downgrade";
  return to > from ? "upgrade" : "downgrade";
}
