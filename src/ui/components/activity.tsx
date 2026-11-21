import * as React from "react";
import {
  Activity,
  Ban,
  CreditCard,
  Gauge,
  Gift,
  Pencil,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import type { ActivityEntry } from "../types.ts";
import { formatDateTime, relativeTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";

/** Icon + tone for an activity type (`grant.created`, `subscription.canceled`, …). */
function iconFor(type: string): { Icon: React.FC<{ className?: string }>; tone: string } {
  if (type.includes("delete") || type.includes("remove") || type.includes("revoke")) {
    return { Icon: Trash2, tone: "text-destructive bg-destructive/10" };
  }
  if (type.includes("cancel")) return { Icon: Ban, tone: "text-destructive bg-destructive/10" };
  if (type.startsWith("trial")) return { Icon: Sparkles, tone: "text-info bg-info/10" };
  if (type.startsWith("subscription") || type.startsWith("plan")) {
    return { Icon: CreditCard, tone: "text-accent bg-accent/10" };
  }
  if (type.startsWith("grant")) return { Icon: Gift, tone: "text-accent bg-accent/10" };
  if (type.startsWith("override")) {
    return { Icon: ShieldAlert, tone: "text-warning bg-warning/10" };
  }
  if (type.startsWith("usage")) return { Icon: Gauge, tone: "text-chart-2 bg-chart-2/10" };
  if (type.startsWith("customer")) {
    return {
      Icon: type.includes("update") ? Pencil : UserRound,
      tone: "text-muted-foreground bg-secondary",
    };
  }
  return { Icon: Activity, tone: "text-muted-foreground bg-secondary" };
}

/** Who did it: actor name / email / id, or "system". */
export function actorLabel(entry: ActivityEntry): string {
  const a = entry.actor;
  if (!a) return "system";
  if (a.type === "portal") return "customer (portal)";
  return a.name ?? a.email ?? a.id;
}

/**
 * A vertical activity timeline. `showCustomer` adds a link to each entry's
 * customer (global activity / overview).
 */
export function ActivityTimeline({
  entries,
  showCustomer,
  onOpenCustomer,
  compact,
}: {
  entries: ActivityEntry[];
  showCustomer?: boolean;
  onOpenCustomer?: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <ol className="relative flex flex-col">
      {entries.map((entry, i) => {
        const { Icon, tone } = iconFor(entry.type);
        const last = i === entries.length - 1;
        return (
          <li key={entry.id} className={cn("relative flex gap-3", compact ? "pb-3" : "pb-4")}>
            {!last && (
              <span className="absolute left-[13px] top-7 bottom-0 w-px bg-border" aria-hidden />
            )}
            <span
              className={cn(
                "relative z-[1] mt-0.5 inline-flex size-[27px] shrink-0 items-center justify-center rounded-full ring-4 ring-card",
                tone,
              )}
              aria-hidden
            >
              <Icon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug text-foreground">{entry.summary}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                {showCustomer ? (
                  <>
                    {onOpenCustomer ? (
                      <button
                        type="button"
                        onClick={() => onOpenCustomer(entry.customer)}
                        className="font-mono text-[11.5px] text-foreground/80 underline-offset-2 outline-none hover:text-accent hover:underline focus-visible:underline"
                      >
                        {entry.customer}
                      </button>
                    ) : (
                      <span className="font-mono text-[11.5px]">{entry.customer}</span>
                    )}
                    <span aria-hidden>·</span>
                  </>
                ) : null}
                <span>{actorLabel(entry)}</span>
                <span aria-hidden>·</span>
                <time dateTime={entry.at} title={formatDateTime(entry.at)}>
                  {relativeTime(entry.at)}
                </time>
                <span aria-hidden>·</span>
                <span className="font-mono text-[11px] text-muted-foreground/80">{entry.type}</span>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
