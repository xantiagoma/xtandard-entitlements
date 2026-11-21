import * as React from "react";
import type { EntitlementSource, SeriesPoint, SubscriptionStatus } from "../types.ts";
import {
  compactNumber,
  formatDate,
  formatNumber,
  niceMax,
  sourceLabel,
  statusLabel,
  statusTone,
  usageLevel,
  usageRatio,
} from "../lib/format.ts";
import { cn } from "../lib/utils.ts";

/* ─── BrandMark ─────────────────────────────────────────────────────────────── */

/**
 * The brand symbol (docs/assets/symbol.svg) inlined so the embed bundle needs
 * no asset: the lime X whose arm is a usage-gauge needle. The gradient and the
 * gauge track come from theme tokens (`--mark-*`), so the light-surface variant
 * (deeper lime) and the dark one (bright lime) follow the theme.
 */
export function BrandMark({ className }: { className?: string }) {
  const id = React.useId().replace(/:/g, "");
  const fill = `url(#${id})`;
  return (
    <svg viewBox="96 98 832 628" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id={id} x1="250" y1="250" x2="760" y2="740" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: "var(--mark-1)" }} />
          <stop offset=".42" style={{ stopColor: "var(--mark-2)" }} />
          <stop offset="1" style={{ stopColor: "var(--mark-3)" }} />
        </linearGradient>
      </defs>
      <g
        fill="none"
        style={{ stroke: "var(--mark-bracket)" }}
        strokeWidth="40"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M190 438L118 512L190 586" />
        <path d="M834 438L906 512L834 586" />
      </g>
      <path d="M250 300L395 300L560 512L395 724L250 724L415 512Z" fill={fill} />
      <path d="M581.6 298L726.6 298L583.0 482.4L510.5 389.3Z" fill={fill} />
      <path d="M580.0 724L725.0 724L583.0 541.6L510.5 634.7Z" fill={fill} />
      <g fill="none" strokeLinecap="round" strokeWidth="34">
        <path d="M528.9 247.1A150 150 0 0 1 749.9 136.7" stroke={fill} />
        <path d="M786.9 165.5A150 150 0 0 1 825.9 247.1" style={{ stroke: "var(--mark-track)" }} />
      </g>
      <path d="M677.4 268.0L743.7 182.8" stroke={fill} strokeWidth="30" strokeLinecap="round" />
      <circle cx="677.4" cy="268.0" r="36" fill={fill} />
    </svg>
  );
}

/* ─── Badges and chips ──────────────────────────────────────────────────────── */

export function StatusBadge({
  status,
  className,
}: {
  status: SubscriptionStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        statusTone(status),
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {statusLabel(status)}
    </span>
  );
}

/** A neutral pill (plan keys, feature kinds, flags). `accent` for the highlighted one. */
export function Chip({
  children,
  accent,
  className,
  title,
}: {
  children: React.ReactNode;
  accent?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        accent
          ? "border-accent/35 bg-accent/10 text-accent"
          : "border-border bg-secondary/60 text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

const SOURCE_TONE: Record<EntitlementSource["type"], string> = {
  plan: "border-border bg-secondary/60 text-foreground",
  default: "border-border bg-secondary/60 text-muted-foreground",
  addon: "border-chart-2/30 bg-chart-2/10 text-chart-2",
  grant: "border-accent/35 bg-accent/10 text-accent",
  override: "border-warning/35 bg-warning/10 text-warning",
};

/** Where part of an entitlement came from: plan / add-on / grant / override. */
export function SourceChip({ source }: { source: EntitlementSource }) {
  const amount =
    source.amount === undefined
      ? ""
      : source.amount === null
        ? " · ∞"
        : ` · ${source.type === "plan" || source.type === "default" ? "" : "+"}${compactNumber(source.amount)}`;
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 font-mono text-[10.5px]",
        SOURCE_TONE[source.type],
      )}
      title={`${sourceLabel(source)}${amount}`}
    >
      {sourceLabel(source)}
      {amount}
    </span>
  );
}

/* ─── UsageBar ──────────────────────────────────────────────────────────────── */

const LEVEL_FILL = {
  ok: "bg-accent",
  warn: "bg-warning",
  critical: "bg-destructive",
} as const;

/**
 * A usage meter with threshold colouring (lime → amber at 75% → red at 90%).
 * Unlimited features render a subtle striped track. Accessible progressbar.
 */
export function UsageBar({
  used,
  limit,
  label,
  className,
  size = "sm",
}: {
  used: number;
  limit: number | null | undefined;
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const ratio = usageRatio(used, limit);
  const level = usageLevel(ratio);
  const pct = ratio === null ? 0 : Math.min(100, Math.max(ratio > 0 ? 2 : 0, ratio * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit ?? undefined}
      aria-valuenow={used}
      aria-valuetext={
        limit === null || limit === undefined
          ? `${formatNumber(used)} used, unlimited`
          : `${formatNumber(used)} of ${formatNumber(limit)}`
      }
      data-level={level}
      className={cn(
        "relative w-full overflow-hidden rounded-full bg-chart-track",
        size === "md" ? "h-2" : "h-1.5",
        className,
      )}
    >
      {ratio === null ? (
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              "repeating-linear-gradient(-45deg, transparent 0 4px, color-mix(in oklab, var(--accent) 22%, transparent) 4px 8px)",
          }}
        />
      ) : (
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", LEVEL_FILL[level])}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}

/* ─── StatCard ──────────────────────────────────────────────────────────────── */

export function StatCard({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        {icon ? <span className="text-muted-foreground/70">{icon}</span> : null}
      </div>
      <p className={cn("mt-1.5 text-2xl font-semibold tabular-nums tracking-tight", tone)}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/* ─── BarList ───────────────────────────────────────────────────────────────── */

/** Horizontal bars for a small categorical distribution (customers by plan). */
export function BarList({
  items,
  onSelect,
}: {
  items: Array<{ key: string; label: React.ReactNode; value: number; tone?: string }>;
  onSelect?: (key: string) => void;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((sum, i) => sum + i.value, 0);
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => {
        const pct = (item.value / max) * 100;
        const share = total === 0 ? 0 : Math.round((item.value / total) * 100);
        const body = (
          <>
            <div className="mb-1 flex items-center justify-between gap-2 text-[13px]">
              <span className="min-w-0 truncate font-medium text-foreground">{item.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatNumber(item.value)}
                <span className="ml-1.5 text-xs text-muted-foreground/70">{share}%</span>
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-chart-track">
              <div
                className={cn("h-full rounded-full", item.tone ?? "bg-chart-1")}
                style={{ width: `${Math.max(pct, item.value > 0 ? 2 : 0)}%` }}
              />
            </div>
          </>
        );
        return (
          <li key={item.key}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(item.key)}
                className="w-full rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ─── UsageChart ────────────────────────────────────────────────────────────── */

/**
 * A tiny dependency-free SVG column chart of a daily series (last 30 days).
 * Scales to its container width; hover/focus a column for its value.
 */
export function UsageChart({
  points,
  unit,
  label,
  height = 140,
}: {
  points: SeriesPoint[];
  unit?: string;
  label: string;
  height?: number;
}) {
  const [active, setActive] = React.useState<number | null>(null);
  // Real pixel width (no viewBox stretching, so labels keep their shape).
  const boxRef = React.useRef<HTMLElement>(null);
  const [width, setWidth] = React.useState(600);
  React.useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setWidth(Math.max(240, Math.round(el.clientWidth)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const padTop = 10;
  const padBottom = 22;
  const padLeft = 36;
  const plotH = height - padTop - padBottom;
  const plotW = width - padLeft;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const step = points.length > 0 ? plotW / points.length : plotW;
  const barW = Math.max(2, step * 0.66);
  const total = points.reduce((s, p) => s + p.value, 0);
  const shown = active === null ? null : points[active];
  const ticks = [0, max / 2, max];

  return (
    <figure className="m-0" ref={boxRef}>
      <figcaption className="mb-2 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {shown ? (
            <>
              <span className="font-medium text-foreground">{formatDate(shown.date)}</span> ·{" "}
              <span className="tabular-nums">{formatNumber(shown.value)}</span>
              {unit ? ` ${unit}` : ""}
            </>
          ) : (
            <>
              Last {points.length} days ·{" "}
              <span className="tabular-nums text-foreground">{formatNumber(total)}</span>
              {unit ? ` ${unit}` : ""} total
            </>
          )}
        </span>
      </figcaption>
      <svg
        role="img"
        aria-label={`${label}: ${formatNumber(total)} over the last ${points.length} days`}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="block max-w-full overflow-visible"
        onMouseLeave={() => setActive(null)}
      >
        {ticks.map((t) => {
          const y = padTop + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line
                x1={padLeft}
                x2={width}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray={t === 0 ? undefined : "3 4"}
              />
              <text
                x={padLeft - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--muted-foreground)"
              >
                {compactNumber(t)}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const h = (p.value / max) * plotH;
          const x = padLeft + i * step + (step - barW) / 2;
          const isActive = active === i;
          return (
            <g key={p.date} onMouseEnter={() => setActive(i)}>
              <rect
                x={padLeft + i * step}
                y={padTop}
                width={step}
                height={plotH}
                fill="transparent"
              />
              <rect
                x={x}
                y={padTop + plotH - Math.max(h, p.value > 0 ? 1.5 : 0)}
                width={barW}
                height={Math.max(h, p.value > 0 ? 1.5 : 0)}
                rx={Math.min(2, barW / 3)}
                fill="var(--chart-1)"
                opacity={active === null || isActive ? 1 : 0.45}
              />
            </g>
          );
        })}
        {points.length > 0 ? (
          <>
            <text x={padLeft} y={height - 6} fontSize="10" fill="var(--muted-foreground)">
              {formatDate(points[0]!.date)}
            </text>
            <text
              x={width}
              y={height - 6}
              fontSize="10"
              textAnchor="end"
              fill="var(--muted-foreground)"
            >
              {formatDate(points[points.length - 1]!.date)}
            </text>
          </>
        ) : null}
      </svg>
    </figure>
  );
}
