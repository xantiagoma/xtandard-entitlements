import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CreditCard, Eye, Sparkles } from "lucide-react";
import { getPortal, portalCheckout, portalManage, setPreviewCustomer } from "../api.ts";
import {
  daysUntil,
  featureSummary,
  formatDate,
  formatNumber,
  formatPrice,
  isNumeric,
  limitLabel,
  resetsInLabel,
} from "../lib/format.ts";
import { keys } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { EmptyCard, LoadingRow, SectionCard } from "../components/bits.tsx";
import { StatusBadge, UsageBar } from "../components/ent-bits.tsx";
import { PricingCards } from "../components/pricing.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button } from "../components/ui-bits.tsx";
import { errorMessage, type PortalView as PortalData } from "../types.ts";

/** Where the browser goes after a link-out (checkout / billing portal). */
function redirect(url: string): void {
  window.location.assign(url);
}

/**
 * The customer portal: current plan and status, usage vs. limits, included
 * features, plan comparison with checkout link-outs, and "Manage billing".
 * Portal-token requests render only this; admins preview it with `?customer=`.
 */
export function PortalView({
  previewCustomer,
  onExitPreview,
}: {
  /** Admin preview of this customer's portal (`?customer=` on the portal routes). */
  previewCustomer?: string;
  onExitPreview?: () => void;
}) {
  // Synchronous so the first query already carries `?customer=`.
  setPreviewCustomer(previewCustomer ?? null);
  React.useEffect(() => () => setPreviewCustomer(null), []);

  const portal = useQuery({
    queryKey: keys.portal(previewCustomer ?? null),
    queryFn: getPortal,
    staleTime: 15_000,
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      {previewCustomer ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-info/30 bg-info/10 px-4 py-2.5 text-[13px] text-info">
          <span className="flex items-center gap-2">
            <Eye className="size-4" />
            Previewing the customer portal of{" "}
            <span className="font-mono font-medium">{previewCustomer}</span>. Checkout and billing
            actions act as this customer.
          </span>
          {onExitPreview ? (
            <Button size="sm" variant="secondary" onClick={onExitPreview}>
              Exit preview
            </Button>
          ) : null}
        </div>
      ) : null}
      {portal.isLoading ? (
        <LoadingRow label="Loading your plan…" />
      ) : portal.isError || !portal.data ? (
        <EmptyCard>
          {errorMessage(portal.error, "We couldn't load your billing details.")}
        </EmptyCard>
      ) : (
        <PortalBody data={portal.data} />
      )}
    </div>
  );
}

function PortalBody({ data }: { data: PortalData }) {
  const toast = useToast();
  const [pending, setPending] = React.useState<string | null>(null);
  const base = data.plans.find((p) => !p.default) ?? data.plans[0];
  const currentKey = base?.plan;
  const current = data.pricing.plans.find((p) => p.key === currentKey);
  const planName = current?.name ?? currentKey ?? "Free";
  const trialDays = base?.status === "trialing" ? daysUntil(base.trialEndsAt) : null;

  const checkout = useMutation({
    mutationFn: (plan: string) =>
      portalCheckout({ plan, successUrl: window.location.href, cancelUrl: window.location.href }),
    onMutate: (plan) => setPending(plan),
    onSuccess: ({ url }) => redirect(url),
    onError: (error) => {
      setPending(null);
      toast.add("error", "Couldn't start checkout", errorMessage(error));
    },
  });
  const manage = useMutation({
    mutationFn: () => portalManage({ returnUrl: window.location.href }),
    onSuccess: ({ url }) => redirect(url),
    onError: (error) => toast.add("error", "Couldn't open billing", errorMessage(error)),
  });

  const meters = data.pricing.features
    .map((f) => ({ f, u: data.features[f.key] }))
    .filter(({ f, u }) => isNumeric(f.kind) && u?.enabled);
  const flags = data.pricing.features
    .map((f) => ({ f, u: data.features[f.key] }))
    .filter(({ f, u }) => !isNumeric(f.kind) && u);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[13px] text-muted-foreground">
            {data.profile.name ?? data.profile.id}
            {data.profile.email ? ` · ${data.profile.email}` : ""}
          </p>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight">Plan &amp; usage</h1>
        </div>
        {data.canManage ? (
          <Button
            variant="secondary"
            icon={<CreditCard className="size-3.5" />}
            loading={manage.isPending}
            onClick={() => manage.mutate()}
          >
            Manage billing
          </Button>
        ) : null}
      </div>

      {/* ── Status banners ─────────────────────────────────────────────────── */}
      {base?.status === "trialing" && trialDays !== null ? (
        <Banner tone="info" icon={<Sparkles className="size-4" />}>
          {trialDays <= 0
            ? `Your ${planName} trial ends today.`
            : `Your ${planName} trial ends in ${trialDays} day${trialDays === 1 ? "" : "s"} (${formatDate(base.trialEndsAt)}).`}{" "}
          {data.canCheckout ? "Subscribe below to keep your features." : null}
        </Banner>
      ) : null}
      {base?.status === "past_due" ? (
        <Banner tone="warning" icon={<AlertTriangle className="size-4" />}>
          Your last payment failed. Update your payment method to keep access.
          {data.canManage ? (
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              onClick={() => manage.mutate()}
            >
              Update payment
            </Button>
          ) : null}
        </Banner>
      ) : null}
      {base?.cancelAtPeriodEnd ? (
        <Banner tone="warning" icon={<CalendarClock className="size-4" />}>
          {planName} is canceled and ends on {formatDate(base.periodEnd)}.
        </Banner>
      ) : null}

      {/* ── Current plan ───────────────────────────────────────────────────── */}
      <section
        aria-label="Current plan"
        className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-gradient-to-r from-accent/[0.07] to-transparent px-5 py-5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Current plan
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-xl font-semibold tracking-tight text-foreground">
                {planName}
              </span>
              {base?.status ? <StatusBadge status={base.status} /> : null}
            </div>
            {current?.description ? (
              <p className="mt-1 text-[13px] text-muted-foreground">{current.description}</p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-xl font-semibold tabular-nums tracking-tight">
              {formatPrice(current?.price)}
            </p>
            <p className="text-xs text-muted-foreground">
              {base?.status === "trialing"
                ? `Trial until ${formatDate(base.trialEndsAt)}`
                : base?.periodEnd
                  ? `${base.cancelAtPeriodEnd ? "Ends" : "Renews"} ${formatDate(base.periodEnd)}`
                  : base?.default
                    ? "No subscription"
                    : ""}
            </p>
          </div>
        </div>
        {data.addons.some((a) => a.applied) ? (
          <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3 text-[13px] text-muted-foreground">
            Add-ons:
            {data.addons
              .filter((a) => a.applied)
              .map((a) => (
                <span key={a.subscriptionId} className="font-medium text-foreground">
                  {data.pricing.addons.find((x) => x.key === a.addon)?.name ?? a.addon}
                  {a.quantity > 1 ? ` ×${a.quantity}` : ""}
                </span>
              ))}
          </div>
        ) : null}
      </section>

      {/* ── Usage ──────────────────────────────────────────────────────────── */}
      {meters.length > 0 ? (
        <SectionCard
          className="mt-4"
          title="Usage"
          description="This period, against your plan's limits."
        >
          <ul className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
            {meters.map(({ f, u }) => {
              const used = u!.used ?? 0;
              return (
                <li key={f.key}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium text-foreground">{f.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      <span className="font-medium text-foreground">{formatNumber(used)}</span> /{" "}
                      {limitLabel(f, u!.limit)}
                    </span>
                  </div>
                  <UsageBar size="md" used={used} limit={u!.limit} label={`${f.name} usage`} />
                  <p className="mt-1.5 flex justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {u!.remaining === null || u!.remaining === undefined
                        ? u!.limit === null
                          ? "Unlimited"
                          : ""
                        : `${formatNumber(u!.remaining)} left`}
                      {u!.overage ? ` · ${formatNumber(u!.overage)} over` : ""}
                    </span>
                    {f.kind !== "capacity" ? <span>{resetsInLabel(u!.resetsAt)}</span> : null}
                  </p>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}

      {/* ── Features ───────────────────────────────────────────────────────── */}
      {flags.length > 0 ? (
        <SectionCard className="mt-4" title="Features">
          <ul className="grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2">
            {flags.map(({ f, u }) => (
              <li key={f.key} className="flex items-center justify-between gap-3 text-[13px]">
                <span className={cn(u!.enabled ? "text-foreground" : "text-muted-foreground")}>
                  {f.name}
                </span>
                <span
                  className={cn(
                    "text-xs font-medium",
                    u!.enabled
                      ? f.kind === "boolean"
                        ? "text-success"
                        : "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {featureSummary(f, u!)}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {/* ── Plans ──────────────────────────────────────────────────────────── */}
      <div className="mt-8">
        <h2 className="text-[15px] font-semibold tracking-tight">Plans</h2>
        <p className="mt-0.5 mb-4 text-[13px] text-muted-foreground">
          Compare plans and switch any time.
        </p>
        <PricingCards
          pricing={data.pricing}
          currentPlan={currentKey}
          onSelect={(plan) => {
            // The default (free) plan has no checkout: leaving a paid plan is a
            // cancellation, which the provider's billing portal handles.
            if (data.pricing.plans.find((p) => p.key === plan)?.default) {
              if (data.canManage) manage.mutate();
              else
                toast.add(
                  "info",
                  "To move to the free plan, cancel your subscription with support.",
                );
              return;
            }
            checkout.mutate(plan);
          }}
          pending={pending}
          disabledHint={
            data.canCheckout
              ? undefined
              : "Online plan changes aren't available for this account — contact support to switch plans."
          }
        />
      </div>
    </>
  );
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "info" | "warning";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "mt-4 flex flex-wrap items-center gap-2.5 rounded-xl border px-4 py-3 text-[13px]",
        tone === "info"
          ? "border-info/30 bg-info/10 text-info"
          : "border-warning/35 bg-warning/10 text-warning",
      )}
    >
      {icon}
      {children}
    </div>
  );
}
