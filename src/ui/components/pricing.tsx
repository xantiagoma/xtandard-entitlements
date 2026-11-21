import * as React from "react";
import { Check, Minus } from "lucide-react";
import type { PricingPlan, PricingTable } from "../types.ts";
import { formatPrice, planDirection } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui-bits.tsx";

/**
 * The plan comparison: one card per plan (current versions), features in
 * catalog order. Used by the catalog's pricing preview (no actions) and the
 * customer portal (current plan marked, Upgrade / Downgrade buttons).
 */
export function PricingCards({
  pricing,
  currentPlan,
  onSelect,
  pending,
  disabledHint,
  group,
}: {
  pricing: PricingTable;
  /** Marked "Current plan"; its button is disabled. */
  currentPlan?: string;
  /** Show Upgrade / Downgrade buttons; called with the plan key. */
  onSelect?: (plan: string) => void;
  /** The plan whose button shows a spinner. */
  pending?: string | null;
  /** When set, the buttons are disabled and this explains why. */
  disabledHint?: string;
  /** Only plans of this group (default: every plan). */
  group?: string;
}) {
  const plans = group ? pricing.plans.filter((p) => p.group === group) : pricing.plans;
  const cols =
    plans.length >= 4 ? "lg:grid-cols-4" : plans.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2";
  return (
    <div>
      <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", cols)}>
        {plans.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            features={pricing.features}
            direction={planDirection(plans, currentPlan, plan.key)}
            hasCurrent={currentPlan !== undefined}
            onSelect={onSelect}
            pending={pending === plan.key}
            disabled={Boolean(disabledHint) || (pending !== null && pending !== undefined)}
          />
        ))}
      </div>
      {onSelect && disabledHint ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">{disabledHint}</p>
      ) : null}
    </div>
  );
}

function PlanCard({
  plan,
  features,
  direction,
  hasCurrent,
  onSelect,
  pending,
  disabled,
}: {
  plan: PricingPlan;
  features: PricingTable["features"];
  direction: "current" | "upgrade" | "downgrade";
  hasCurrent: boolean;
  onSelect?: (plan: string) => void;
  pending: boolean;
  disabled: boolean;
}) {
  const current = direction === "current";
  const [price, per] = splitPrice(formatPrice(plan.price));
  return (
    <article
      aria-label={`${plan.name} plan`}
      data-current={current || undefined}
      className={cn(
        "relative flex flex-col rounded-xl border bg-card p-5 shadow-sm",
        current
          ? "border-accent ring-1 ring-accent"
          : plan.highlight
            ? "border-accent/50"
            : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{plan.name}</h3>
        {current ? (
          <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-accent-foreground">
            Current plan
          </span>
        ) : plan.highlight ? (
          <span className="rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent">
            Popular
          </span>
        ) : null}
      </div>
      <p className="mt-1 min-h-10 text-xs leading-relaxed text-muted-foreground">
        {plan.description ?? ""}
      </p>
      <p className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
          {price}
        </span>
        {per ? <span className="text-[13px] text-muted-foreground">{per}</span> : null}
      </p>
      <p className="mt-1 h-4 text-xs text-muted-foreground">
        {plan.trialDays ? `${plan.trialDays}-day free trial` : ""}
      </p>

      {onSelect ? (
        <Button
          className="mt-4 w-full justify-center"
          variant={current ? "secondary" : direction === "upgrade" ? "primary" : "secondary"}
          disabled={current || disabled}
          loading={pending}
          onClick={() => onSelect(plan.key)}
        >
          {current
            ? "Current plan"
            : !hasCurrent
              ? `Choose ${plan.name}`
              : direction === "upgrade"
                ? `Upgrade to ${plan.name}`
                : `Downgrade to ${plan.name}`}
        </Button>
      ) : null}

      <ul className="mt-5 flex flex-col gap-2 border-t border-border pt-4">
        {features.map((f) => {
          const cell = plan.features[f.key];
          if (!cell) return null;
          const included = cell.included;
          return (
            <li
              key={f.key}
              className={cn(
                "flex items-start gap-2 text-[13px]",
                included ? "text-foreground" : "text-muted-foreground/70",
              )}
            >
              {included ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-accent" aria-label="Included" />
              ) : (
                <Minus className="mt-0.5 size-3.5 shrink-0" aria-label="Not included" />
              )}
              <span className="min-w-0">
                {f.kind === "boolean" || !included ? (
                  f.name
                ) : (
                  <>
                    <span className="font-medium">{cell.label}</span>{" "}
                    <span className="text-muted-foreground">· {f.name}</span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

/** `"$29 / mo"` → `["$29", "/ mo"]`. */
function splitPrice(label: string): [string, string] {
  const i = label.indexOf(" ");
  return i === -1 ? [label, ""] : [label.slice(0, i), label.slice(i + 1)];
}

export type PricingCardsProps = React.ComponentProps<typeof PricingCards>;
