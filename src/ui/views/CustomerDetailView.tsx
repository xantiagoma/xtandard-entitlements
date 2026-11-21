import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpCircle,
  ExternalLink,
  Gift,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  cancelSubscription,
  customerActivity,
  getCustomer,
  migratePlan,
  removeOverride,
  removeSubscription,
  resetUsage,
  revokeGrant,
  updateSubscription,
  usageSeries,
} from "../api.ts";
import {
  featureSummary,
  formatDate,
  formatDateTime,
  formatNumber,
  initials,
  isNumeric,
  limitLabel,
  relativeTime,
  resetsInLabel,
} from "../lib/format.ts";
import { useCustomerAction } from "../lib/mutations.ts";
import { keys, useCatalog, type CatalogIndex } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { ConfirmDialog, EmptyCard, LoadingRow, Mono, SectionCard } from "../components/bits.tsx";
import { Chip, SourceChip, StatusBadge, UsageBar, UsageChart } from "../components/ent-bits.tsx";
import { ActivityTimeline } from "../components/activity.tsx";
import { Segmented } from "../components/primitives.tsx";
import { Avatar, Button } from "../components/ui-bits.tsx";
import {
  ChangePlanDialog,
  EditProfileDialog,
  GrantDialog,
  OverrideDialog,
  SetUsageDialog,
  StartTrialDialog,
} from "./customer-dialogs.tsx";
import type {
  CustomerDetail,
  FeatureUsage,
  Grant,
  NormalizedFeature,
  Override,
  Subscription,
} from "../types.ts";

/** A pending confirmation (one dialog serves every destructive action). */
type Confirm =
  | { kind: "cancel"; sub: Subscription }
  | { kind: "remove-sub"; sub: Subscription }
  | { kind: "migrate"; sub: Subscription; to: number }
  | { kind: "revoke"; grant: Grant }
  | { kind: "remove-override"; override: Override }
  | { kind: "reset"; feature: NormalizedFeature };

type Dialog =
  | { kind: "profile" }
  | { kind: "plan" }
  | { kind: "trial" }
  | { kind: "grant"; feature?: string }
  | { kind: "override"; feature?: string }
  | { kind: "usage"; feature: NormalizedFeature };

/** One customer: profile, subscriptions, entitlements, grants, overrides, usage, activity. */
export function CustomerDetailView({
  id,
  readonly,
  onBack,
  onOpenPortal,
}: {
  id: string;
  readonly: boolean;
  onBack: () => void;
  onOpenPortal: (id: string) => void;
}) {
  const detail = useQuery({
    queryKey: keys.customer(id),
    queryFn: () => getCustomer(id),
    staleTime: 5_000,
  });
  const catalog = useCatalog();

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 rounded-md text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-3.5" />
        Customers
      </button>
      {detail.isLoading || catalog.isLoading ? (
        <LoadingRow label="Loading customer…" />
      ) : detail.isError || !detail.data || !catalog.data ? (
        <EmptyCard>Failed to load this customer.</EmptyCard>
      ) : (
        <CustomerBody
          id={id}
          data={detail.data}
          catalog={catalog.data}
          readonly={readonly}
          onOpenPortal={onOpenPortal}
        />
      )}
    </div>
  );
}

function CustomerBody({
  id,
  data,
  catalog,
  readonly,
  onOpenPortal,
}: {
  id: string;
  data: CustomerDetail;
  catalog: CatalogIndex;
  readonly: boolean;
  onOpenPortal: (id: string) => void;
}) {
  const { state, entitlements } = data;
  const [dialog, setDialog] = React.useState<Dialog | null>(null);
  const [confirm, setConfirm] = React.useState<Confirm | null>(null);
  const close = () => setDialog(null);
  const closeConfirm = () => setConfirm(null);

  const features = catalog.view.features;
  const basePlan = entitlements.plans.find((p) => !p.default) ?? entitlements.plans[0];
  const subscriptions = [...(state?.subscriptions ?? [])].sort(
    (a, b) =>
      Number(a.status === "canceled") - Number(b.status === "canceled") ||
      b.createdAt.localeCompare(a.createdAt),
  );

  // Destructive / confirm-first actions share one mutation each.
  const cancel = useCustomerAction(
    id,
    (v: { sub: Subscription; atPeriodEnd: boolean }) =>
      cancelSubscription(id, v.sub.id, v.atPeriodEnd),
    {
      success: (v) => (v.atPeriodEnd ? "Cancels at period end" : "Subscription canceled"),
      error: "Could not cancel the subscription",
      onSuccess: closeConfirm,
    },
  );
  const resume = useCustomerAction(
    id,
    (sub: Subscription) => updateSubscription(id, sub.id, { cancelAtPeriodEnd: false }),
    { success: "Cancellation undone", error: "Could not resume the subscription" },
  );
  const removeSub = useCustomerAction(id, (sub: Subscription) => removeSubscription(id, sub.id), {
    success: "Subscription removed",
    error: "Could not remove the subscription",
    onSuccess: closeConfirm,
  });
  const migrate = useCustomerAction(
    id,
    (v: { sub: Subscription; to: number }) =>
      migratePlan(v.sub.plan, { toVersion: v.to, customer: id }),
    {
      success: (v) => `Migrated to ${catalog.planName(v.sub.plan)} v${v.to}`,
      error: "Could not migrate the plan version",
      onSuccess: closeConfirm,
    },
  );
  const revoke = useCustomerAction(id, (g: Grant) => revokeGrant(id, g.id), {
    success: "Grant revoked",
    error: "Could not revoke the grant",
    onSuccess: closeConfirm,
  });
  const unoverride = useCustomerAction(id, (o: Override) => removeOverride(id, o.id), {
    success: "Override removed",
    error: "Could not remove the override",
    onSuccess: closeConfirm,
  });
  const reset = useCustomerAction(id, (f: NormalizedFeature) => resetUsage(id, f.key), {
    success: (f) => `${f.name} usage reset`,
    error: "Could not reset usage",
    onSuccess: closeConfirm,
  });

  const displayName = state?.name ?? id;

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <Avatar initials={initials(displayName)} className="size-11 text-sm" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{displayName}</h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
              <Mono className="text-muted-foreground">{id}</Mono>
              {state?.email ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{state.email}</span>
                </>
              ) : null}
              {state ? (
                <>
                  <span aria-hidden>·</span>
                  <span title={formatDateTime(state.createdAt)}>
                    customer since {formatDate(state.createdAt)}
                  </span>
                </>
              ) : (
                <>
                  <span aria-hidden>·</span>
                  <span>no stored state (default plan)</span>
                </>
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {entitlements.plans.map((p) => (
                <Chip key={`${p.group}:${p.plan}`} accent={!p.default}>
                  {catalog.planName(p.plan)}
                  {p.version > 1 ? ` v${p.version}` : ""}
                  {p.default ? " · default" : ""}
                </Chip>
              ))}
              {entitlements.addons
                .filter((a) => a.applied)
                .map((a) => (
                  <Chip key={a.subscriptionId}>
                    + {catalog.planName(a.addon)}
                    {a.quantity > 1 ? ` ×${a.quantity}` : ""}
                  </Chip>
                ))}
              {entitlements.stale ? <Chip className="text-warning">stale</Chip> : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            icon={<ExternalLink className="size-3.5" />}
            onClick={() => onOpenPortal(id)}
          >
            Open portal preview
          </Button>
          {!readonly && (
            <Button
              variant="secondary"
              icon={<Pencil className="size-3.5" />}
              onClick={() => setDialog({ kind: "profile" })}
            >
              Edit profile
            </Button>
          )}
        </div>
      </div>

      {/* ── Subscriptions ──────────────────────────────────────────────────── */}
      <SectionCard
        className="mt-6"
        title="Plans & subscriptions"
        description={
          basePlan
            ? `Entitled to ${catalog.planName(basePlan.plan)}${basePlan.default ? " (default plan)" : ""}.`
            : undefined
        }
        actions={
          readonly ? null : (
            <>
              <Button
                size="sm"
                variant="secondary"
                icon={<Sparkles className="size-3.5" />}
                onClick={() => setDialog({ kind: "trial" })}
              >
                Start trial
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<ArrowUpCircle className="size-3.5" />}
                onClick={() => setDialog({ kind: "plan" })}
              >
                Change plan
              </Button>
            </>
          )
        }
        flush
      >
        {subscriptions.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
            No subscriptions — the customer is on the default plan.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {subscriptions.map((sub) => {
              const current = catalog.plan(sub.plan);
              const outdated = sub.kind === "plan" && current && sub.version < current.version;
              const inactive = entitlements.inactive.find((i) => i.subscriptionId === sub.id);
              const live = sub.status !== "canceled";
              return (
                <li key={sub.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-foreground">
                        {catalog.planName(sub.plan)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {sub.kind === "addon" ? "add-on" : `v${sub.version}`}
                        {sub.quantity > 1 ? ` · ×${sub.quantity}` : ""}
                      </span>
                      <StatusBadge status={sub.status} />
                      {sub.cancelAtPeriodEnd && live ? (
                        <Chip className="border-warning/35 bg-warning/10 text-warning">
                          cancels {formatDate(sub.periodEnd)}
                        </Chip>
                      ) : null}
                      {outdated ? <Chip title="A newer version exists">legacy version</Chip> : null}
                      <Chip>{sub.provider}</Chip>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {sub.status === "trialing" && sub.trialEndsAt
                        ? `Trial ends ${formatDate(sub.trialEndsAt)} (${relativeTime(sub.trialEndsAt)})`
                        : sub.periodEnd
                          ? `${live ? "Renews" : "Ended"} ${formatDate(sub.periodEnd)}`
                          : `Started ${formatDate(sub.periodStart ?? sub.createdAt)}`}
                      {inactive ? ` · not entitled: ${inactive.reason}` : ""}
                    </p>
                  </div>
                  {!readonly && live ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {outdated && current ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setConfirm({ kind: "migrate", sub, to: current.version })}
                        >
                          Migrate to v{current.version}
                        </Button>
                      ) : null}
                      {sub.cancelAtPeriodEnd ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={resume.isPending && resume.variables?.id === sub.id}
                          onClick={() => resume.mutate(sub)}
                        >
                          Resume
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirm({ kind: "cancel", sub })}
                        >
                          Cancel
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${catalog.planName(sub.plan)} subscription`}
                        title="Remove"
                        onClick={() => setConfirm({ kind: "remove-sub", sub })}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {/* ── Entitlements ───────────────────────────────────────────────────── */}
      <SectionCard
        className="mt-4"
        title="Entitlements"
        description="What the engine decides right now, with this period's usage."
        flush
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-semibold">Feature</th>
                <th className="w-[34%] px-4 py-2.5 font-semibold">Usage</th>
                <th className="px-4 py-2.5 font-semibold">Remaining</th>
                <th className="px-4 py-2.5 font-semibold">Resets</th>
                <th className="px-4 py-2.5 font-semibold">Sources</th>
                {!readonly && <th className="px-4 py-2.5" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {features.map((f) => {
                const u = entitlements.features[f.key];
                if (!u) return null;
                return (
                  <EntitlementRow
                    key={f.key}
                    feature={f}
                    usage={u}
                    readonly={readonly}
                    onSet={() => setDialog({ kind: "usage", feature: f })}
                    onReset={() => setConfirm({ kind: "reset", feature: f })}
                    onGrant={() => setDialog({ kind: "grant", feature: f.key })}
                    onOverride={() => setDialog({ kind: "override", feature: f.key })}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* ── Usage chart + activity ─────────────────────────────────────────── */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <UsageCard id={id} features={features} className="lg:col-span-3" />
        <CustomerActivity id={id} className="lg:col-span-2" />
      </div>

      {/* ── Grants + overrides ─────────────────────────────────────────────── */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard
          title="Grants"
          description="Extra balances: one-off buckets or recurring allowance."
          actions={
            readonly ? null : (
              <Button
                size="sm"
                variant="secondary"
                icon={<Gift className="size-3.5" />}
                onClick={() => setDialog({ kind: "grant" })}
              >
                Add grant
              </Button>
            )
          }
          flush
        >
          {(state?.grants.length ?? 0) === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">No grants.</p>
          ) : (
            <ul className="divide-y divide-border">
              {state!.grants.map((g) => {
                const f = catalog.feature(g.feature);
                const balance = entitlements.features[g.feature]?.grantBalances?.find(
                  (b) => b.id === g.id,
                );
                const expired = g.expiresAt !== undefined && Date.parse(g.expiresAt) <= Date.now();
                return (
                  <li key={g.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-foreground">
                        <span className="font-semibold tabular-nums">
                          +{limitLabel(f ?? {}, g.amount)}
                        </span>{" "}
                        {f?.name ?? g.feature}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {g.recurring ? <Chip accent>recurring</Chip> : <Chip>one-off</Chip>}
                        {g.priority !== 0 ? <Chip>priority {g.priority}</Chip> : null}
                        {g.expiresAt ? (
                          <Chip className={expired ? "text-destructive" : undefined}>
                            {expired ? "expired" : "expires"} {formatDate(g.expiresAt)}
                          </Chip>
                        ) : null}
                        {balance ? (
                          <Chip>
                            {formatNumber(balance.used)} / {formatNumber(balance.amount)} used
                          </Chip>
                        ) : null}
                      </div>
                      {g.reason ? (
                        <p className="mt-1 text-xs italic text-muted-foreground">“{g.reason}”</p>
                      ) : null}
                    </div>
                    {!readonly && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirm({ kind: "revoke", grant: g })}
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Overrides"
          description="Operator exceptions that replace the resolved result."
          actions={
            readonly ? null : (
              <Button
                size="sm"
                variant="secondary"
                icon={<ShieldAlert className="size-3.5" />}
                onClick={() => setDialog({ kind: "override" })}
              >
                Add override
              </Button>
            )
          }
          flush
        >
          {(state?.overrides.length ?? 0) === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">No overrides.</p>
          ) : (
            <ul className="divide-y divide-border">
              {state!.overrides.map((o) => {
                const f = catalog.feature(o.feature);
                return (
                  <li key={o.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-foreground">
                        <span className="font-semibold">{f?.name ?? o.feature}</span>{" "}
                        <span className="text-muted-foreground">→ {overrideSummary(o, f)}</span>
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {o.expiresAt ? (
                          <Chip>until {formatDate(o.expiresAt)}</Chip>
                        ) : (
                          <Chip>no expiry</Chip>
                        )}
                        {o.actor ? (
                          <Chip>by {o.actor.name ?? o.actor.email ?? o.actor.id}</Chip>
                        ) : null}
                      </div>
                      {o.reason ? (
                        <p className="mt-1 text-xs italic text-muted-foreground">“{o.reason}”</p>
                      ) : null}
                    </div>
                    {!readonly && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirm({ kind: "remove-override", override: o })}
                      >
                        Remove
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* ── Dialogs ────────────────────────────────────────────────────────── */}
      <EditProfileDialog
        customer={id}
        open={dialog?.kind === "profile"}
        onClose={close}
        state={state}
      />
      <ChangePlanDialog
        customer={id}
        open={dialog?.kind === "plan"}
        onClose={close}
        catalog={catalog.view}
        currentPlan={basePlan?.default ? undefined : basePlan?.plan}
      />
      <StartTrialDialog
        customer={id}
        open={dialog?.kind === "trial"}
        onClose={close}
        catalog={catalog.view}
        usedTrials={state?.trials ?? {}}
      />
      <GrantDialog
        customer={id}
        open={dialog?.kind === "grant"}
        onClose={close}
        features={features}
        initialFeature={dialog?.kind === "grant" ? dialog.feature : undefined}
      />
      <OverrideDialog
        customer={id}
        open={dialog?.kind === "override"}
        onClose={close}
        features={features}
        initialFeature={dialog?.kind === "override" ? dialog.feature : undefined}
      />
      <SetUsageDialog
        customer={id}
        open={dialog?.kind === "usage"}
        onClose={close}
        feature={dialog?.kind === "usage" ? dialog.feature : null}
        usage={dialog?.kind === "usage" ? entitlements.features[dialog.feature.key] : undefined}
      />

      <ConfirmDialog
        open={confirm?.kind === "cancel"}
        onClose={closeConfirm}
        title="Cancel subscription"
        confirmLabel="Cancel immediately"
        danger
        loading={cancel.isPending && !cancel.variables?.atPeriodEnd}
        onConfirm={() =>
          confirm?.kind === "cancel" && cancel.mutate({ sub: confirm.sub, atPeriodEnd: false })
        }
      >
        <p className="text-[13px] text-muted-foreground">
          Cancel{" "}
          <span className="font-medium text-foreground">
            {confirm?.kind === "cancel" ? catalog.planName(confirm.sub.plan) : ""}
          </span>{" "}
          now, or keep access until the period ends.
        </p>
        {confirm?.kind === "cancel" && confirm.sub.periodEnd ? (
          <Button
            variant="secondary"
            loading={cancel.isPending && cancel.variables?.atPeriodEnd === true}
            onClick={() => cancel.mutate({ sub: confirm.sub, atPeriodEnd: true })}
          >
            <RotateCcw className="size-3.5" />
            Cancel at period end ({formatDate(confirm.sub.periodEnd)})
          </Button>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "remove-sub"}
        onClose={closeConfirm}
        title="Remove subscription"
        confirmLabel="Remove"
        danger
        loading={removeSub.isPending}
        onConfirm={() => confirm?.kind === "remove-sub" && removeSub.mutate(confirm.sub)}
      >
        <p className="text-[13px] text-muted-foreground">
          Deletes the subscription record entirely (no cancellation history). Prefer{" "}
          <span className="font-medium text-foreground">Cancel</span> for real customers; removal is
          for mistakes and test data.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "migrate"}
        onClose={closeConfirm}
        title="Migrate plan version"
        confirmLabel="Migrate"
        loading={migrate.isPending}
        onConfirm={() =>
          confirm?.kind === "migrate" && migrate.mutate({ sub: confirm.sub, to: confirm.to })
        }
      >
        <p className="text-[13px] text-muted-foreground">
          Move this customer off a grandfathered version onto{" "}
          <span className="font-medium text-foreground">
            {confirm?.kind === "migrate"
              ? `${catalog.planName(confirm.sub.plan)} v${confirm.to}`
              : ""}
          </span>
          . Their limits change immediately.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "revoke"}
        onClose={closeConfirm}
        title="Revoke grant"
        confirmLabel="Revoke"
        danger
        loading={revoke.isPending}
        onConfirm={() => confirm?.kind === "revoke" && revoke.mutate(confirm.grant)}
      >
        <p className="text-[13px] text-muted-foreground">
          The remaining balance of this grant is removed. Usage already consumed stays counted.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "remove-override"}
        onClose={closeConfirm}
        title="Remove override"
        confirmLabel="Remove override"
        danger
        loading={unoverride.isPending}
        onConfirm={() => confirm?.kind === "remove-override" && unoverride.mutate(confirm.override)}
      >
        <p className="text-[13px] text-muted-foreground">
          The feature goes back to what the plan, add-ons and grants resolve to.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "reset"}
        onClose={closeConfirm}
        title="Reset usage"
        confirmLabel="Reset usage"
        danger
        loading={reset.isPending}
        onConfirm={() => confirm?.kind === "reset" && reset.mutate(confirm.feature)}
      >
        <p className="text-[13px] text-muted-foreground">
          Sets this period's{" "}
          <span className="font-medium text-foreground">
            {confirm?.kind === "reset" ? confirm.feature.name : ""}
          </span>{" "}
          counter back to zero.
        </p>
      </ConfirmDialog>
    </>
  );
}

function overrideSummary(o: Override, f: NormalizedFeature | undefined): string {
  const parts: string[] = [];
  if (o.enabled === true) parts.push("force enabled");
  if (o.enabled === false) parts.push("disabled");
  if (o.limit === null) parts.push("unlimited");
  else if (o.limit !== undefined) parts.push(`limit ${limitLabel(f ?? {}, o.limit)}`);
  if (o.overage) parts.push(`overage ${o.overage}`);
  if (o.value !== undefined) parts.push(`value ${JSON.stringify(o.value)}`);
  return parts.join(", ") || "no change";
}

function EntitlementRow({
  feature,
  usage,
  readonly,
  onSet,
  onReset,
  onGrant,
  onOverride,
}: {
  feature: NormalizedFeature;
  usage: FeatureUsage;
  readonly: boolean;
  onSet: () => void;
  onReset: () => void;
  onGrant: () => void;
  onOverride: () => void;
}) {
  const numeric = isNumeric(feature.kind);
  const used = usage.used ?? 0;
  return (
    <tr className={cn("align-top", !usage.enabled && "text-muted-foreground")}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              usage.enabled ? "bg-success" : "bg-muted-foreground/40",
            )}
            aria-label={usage.enabled ? "enabled" : "not included"}
          />
          <span className={cn("font-medium", usage.enabled ? "text-foreground" : "")}>
            {feature.name}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 pl-3">
          <Mono className="text-[11px] text-muted-foreground">{feature.key}</Mono>
          <span className="text-[10.5px] text-muted-foreground">{feature.kind}</span>
        </div>
      </td>
      <td className="px-4 py-3">
        {numeric && usage.enabled ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="tabular-nums text-foreground">
                {formatNumber(used)}{" "}
                <span className="text-muted-foreground">/ {limitLabel(feature, usage.limit)}</span>
              </span>
              {usage.overage ? (
                <span className="text-warning">+{formatNumber(usage.overage)} overage</span>
              ) : null}
            </div>
            <UsageBar used={used} limit={usage.limit} label={`${feature.name} usage`} />
          </div>
        ) : (
          <span className={cn("text-[13px]", usage.enabled ? "text-foreground" : "")}>
            {featureSummary(feature, usage)}
          </span>
        )}
      </td>
      <td className="px-4 py-3 tabular-nums">
        {numeric && usage.enabled
          ? usage.remaining === null || usage.remaining === undefined
            ? usage.limit === null
              ? "∞"
              : "—"
            : formatNumber(usage.remaining)
          : "—"}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
        {numeric && usage.enabled && feature.kind !== "capacity" ? (
          <span title={formatDateTime(usage.resetsAt)}>{resetsInLabel(usage.resetsAt)}</span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex max-w-64 flex-wrap gap-1">
          {usage.sources.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            usage.sources.map((s, i) => <SourceChip key={`${s.type}:${s.id}:${i}`} source={s} />)
          )}
        </div>
      </td>
      {!readonly && (
        <td className="whitespace-nowrap px-3 py-2.5 text-right">
          <div className="flex justify-end gap-0.5">
            {numeric && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Set usage"
                  aria-label={`Set ${feature.name} usage`}
                  onClick={onSet}
                >
                  <Pencil className="size-3.5" />
                </Button>
                {feature.kind !== "capacity" && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Reset usage"
                    aria-label={`Reset ${feature.name} usage`}
                    onClick={onReset}
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  title="Add grant"
                  aria-label={`Grant ${feature.name}`}
                  onClick={onGrant}
                >
                  <Plus className="size-3.5" />
                </Button>
              </>
            )}
            <Button
              size="icon"
              variant="ghost"
              title="Override"
              aria-label={`Override ${feature.name}`}
              onClick={onOverride}
            >
              <ShieldAlert className="size-3.5" />
            </Button>
          </div>
        </td>
      )}
    </tr>
  );
}

function UsageCard({
  id,
  features,
  className,
}: {
  id: string;
  features: NormalizedFeature[];
  className?: string;
}) {
  const metered = features.filter((f) => f.kind === "metered" || f.kind === "credits");
  const [selected, setSelected] = React.useState<string>(metered[0]?.key ?? "");
  const series = useQuery({
    queryKey: keys.series(id, selected),
    queryFn: () => usageSeries(id, selected, 30),
    enabled: selected !== "",
    staleTime: 30_000,
  });
  const f = metered.find((x) => x.key === selected);
  return (
    <SectionCard
      title="Daily usage"
      description="Last 30 days, per metered feature."
      className={className}
      actions={
        metered.length > 1 ? (
          <Segmented
            size="sm"
            value={selected}
            onValueChange={setSelected}
            options={metered.slice(0, 4).map((m) => ({ value: m.key, label: m.name }))}
          />
        ) : null
      }
    >
      {metered.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">
          No metered features in the catalog.
        </p>
      ) : series.isLoading ? (
        <LoadingRow label="Loading usage…" />
      ) : series.isError ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">Failed to load usage.</p>
      ) : (
        <UsageChart
          points={series.data ?? []}
          unit={f?.units ?? f?.unit}
          label={`${f?.name ?? selected} daily usage`}
        />
      )}
    </SectionCard>
  );
}

function CustomerActivity({ id, className }: { id: string; className?: string }) {
  const activity = useQuery({
    queryKey: keys.customerActivity(id),
    queryFn: () => customerActivity(id, 30),
    staleTime: 5_000,
  });
  return (
    <SectionCard title="Activity" className={className}>
      {activity.isLoading ? (
        <LoadingRow label="Loading activity…" />
      ) : (activity.data ?? []).length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">No activity yet.</p>
      ) : (
        <div className="max-h-[260px] overflow-y-auto pr-1">
          <ActivityTimeline entries={activity.data!} compact />
        </div>
      )}
    </SectionCard>
  );
}
