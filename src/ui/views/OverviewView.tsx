import React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, ChevronRight, CircleAlert, CreditCard, Sparkles, Users } from "lucide-react";
import { getOverview } from "../api.ts";
import { daysUntil, formatDate, formatNumber, STATUSES, statusLabel } from "../lib/format.ts";
import { keys, useCatalog } from "../lib/queries.ts";
import { BarList, StatCard, StatusBadge } from "../components/ent-bits.tsx";
import { ActivityTimeline } from "../components/activity.tsx";
import type { Overview, SubscriptionStatus } from "../types.ts";
import { Button, cn, EmptyCard, LoadingRow, Mono, PageHeader, SectionCard } from "@xtandard/kit/ui";

const STATUS_FILL: Record<SubscriptionStatus, string> = {
  active: "bg-success",
  trialing: "bg-info",
  past_due: "bg-warning",
  incomplete: "bg-chart-3",
  paused: "bg-muted-foreground/50",
  canceled: "bg-destructive",
};

/** Customers, plan mix, subscription health, trials ending soon and recent changes. */
export function OverviewView({
  onOpenCustomer,
  onOpenCustomers,
  onOpenActivity,
}: {
  onOpenCustomer: (id: string) => void;
  onOpenCustomers: () => void;
  onOpenActivity: () => void;
}) {
  const overview = useQuery({ queryKey: keys.overview, queryFn: getOverview, staleTime: 15_000 });
  const catalog = useCatalog();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader
        title="Overview"
        description="Who is on which plan, subscription health and what changed recently."
      />

      {overview.isLoading ? (
        <LoadingRow label="Loading overview…" />
      ) : overview.isError || !overview.data ? (
        <EmptyCard>Failed to load the overview.</EmptyCard>
      ) : (
        <OverviewBody
          data={overview.data}
          planName={(k) => catalog.data?.planName(k) ?? k}
          planOrder={catalog.data?.view.pricing.plans.map((p) => p.key) ?? []}
          onOpenCustomer={onOpenCustomer}
          onOpenCustomers={onOpenCustomers}
          onOpenActivity={onOpenActivity}
        />
      )}
    </div>
  );
}

function OverviewBody({
  data,
  planName,
  planOrder,
  onOpenCustomer,
  onOpenCustomers,
  onOpenActivity,
}: {
  data: Overview;
  planName: (key: string) => string;
  planOrder: string[];
  onOpenCustomer: (id: string) => void;
  onOpenCustomers: () => void;
  onOpenActivity: () => void;
}) {
  const statuses = STATUSES.map((s) => ({ status: s, count: data.statuses[s] ?? 0 }));
  const totalSubs = statuses.reduce((sum, s) => sum + s.count, 0);
  const paying = data.statuses.active ?? 0;
  const pastDue = (data.statuses.past_due ?? 0) + (data.statuses.incomplete ?? 0);
  const rank = (k: string) => {
    const i = planOrder.indexOf(k);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const byPlan = Object.entries(data.byPlan)
    .sort(([a, x], [b, y]) => rank(a) - rank(b) || y - x)
    .map(([key, value], i) => ({
      key,
      value,
      label: (
        <span className="flex items-center gap-2">
          {planName(key)}
          <Mono className="text-[11px] text-muted-foreground">{key}</Mono>
        </span>
      ),
      tone: ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-5", "bg-chart-4"][i % 5],
    }));

  return (
    <>
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Customers"
          value={formatNumber(data.customers)}
          hint={`${Object.keys(data.byPlan).length} plans in use`}
          icon={<Users className="size-4" />}
        />
        <StatCard
          label="Active subscriptions"
          value={formatNumber(paying)}
          hint={`${formatNumber(totalSubs)} subscriptions in total`}
          tone="text-success"
          icon={<CreditCard className="size-4" />}
        />
        <StatCard
          label="Trialing"
          value={formatNumber(data.statuses.trialing ?? 0)}
          hint={`${data.trialsEndingSoon.length} ending in the next 7 days`}
          tone="text-info"
          icon={<Sparkles className="size-4" />}
        />
        <StatCard
          label="Needs attention"
          value={formatNumber(pastDue)}
          hint="Past due or incomplete payments"
          tone={pastDue > 0 ? "text-warning" : undefined}
          icon={<CircleAlert className="size-4" />}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <SectionCard
          title="Customers by plan"
          description="Entitled plan per customer (default plans included)."
          className="shadow-sm lg:col-span-3"
          actions={
            <Button size="sm" variant="ghost" onClick={onOpenCustomers}>
              All customers
              <ChevronRight className="size-3.5" />
            </Button>
          }
        >
          {byPlan.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">No customers yet.</p>
          ) : (
            <BarList items={byPlan} />
          )}
        </SectionCard>

        <SectionCard
          title="Subscription status"
          description={`${formatNumber(totalSubs)} subscriptions`}
          className="shadow-sm lg:col-span-2"
        >
          {totalSubs === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">
              No subscriptions yet.
            </p>
          ) : (
            <>
              <div
                className="flex h-2.5 w-full overflow-hidden rounded-full bg-chart-track"
                role="img"
                aria-label={statuses
                  .filter((s) => s.count > 0)
                  .map((s) => `${statusLabel(s.status)} ${s.count}`)
                  .join(", ")}
              >
                {statuses
                  .filter((s) => s.count > 0)
                  .map((s) => (
                    <div
                      key={s.status}
                      className={cn(
                        "h-full first:rounded-l-full last:rounded-r-full",
                        STATUS_FILL[s.status],
                      )}
                      style={{ width: `${(s.count / totalSubs) * 100}%` }}
                    />
                  ))}
              </div>
              <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5">
                {statuses.map((s) => (
                  <li key={s.status} className="flex items-center justify-between gap-2">
                    <StatusBadge status={s.status} />
                    <span
                      className={cn(
                        "text-[13px] tabular-nums",
                        s.count === 0 ? "text-muted-foreground/60" : "text-foreground",
                      )}
                    >
                      {formatNumber(s.count)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </SectionCard>
      </div>

      <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-5">
        <SectionCard
          title="Trials ending soon"
          description="Next 7 days, soonest first."
          className="shadow-sm lg:col-span-2"
          flush
        >
          {data.trialsEndingSoon.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">
              No trials end this week.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.trialsEndingSoon.map((t) => {
                const days = daysUntil(t.trialEndsAt) ?? 0;
                return (
                  <li key={`${t.customer}-${t.plan}`}>
                    <button
                      type="button"
                      onClick={() => onOpenCustomer(t.customer)}
                      className="group flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/40"
                    >
                      <AlarmClock
                        className={cn(
                          "size-4 shrink-0",
                          days <= 2 ? "text-warning" : "text-muted-foreground",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <Mono className="block truncate">{t.customer}</Mono>
                        <p className="text-xs text-muted-foreground">
                          {planName(t.plan)} · ends {formatDate(t.trialEndsAt)}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "whitespace-nowrap text-xs font-medium tabular-nums",
                          days <= 2 ? "text-warning" : "text-muted-foreground",
                        )}
                      >
                        {days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Recent activity"
          className="shadow-sm lg:col-span-3"
          actions={
            <Button size="sm" variant="ghost" onClick={onOpenActivity}>
              View all
              <ChevronRight className="size-3.5" />
            </Button>
          }
        >
          {data.recentActivity.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">No activity yet.</p>
          ) : (
            <ActivityTimeline
              entries={data.recentActivity.slice(0, 8)}
              showCustomer
              onOpenCustomer={onOpenCustomer}
              compact
            />
          )}
        </SectionCard>
      </div>
    </>
  );
}
