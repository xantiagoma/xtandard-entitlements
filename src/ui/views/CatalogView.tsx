import React from "react";
import { EyeOff, Star } from "lucide-react";
import { useCatalog } from "../lib/queries.ts";
import { entryLabel, formatPrice, resetLabel } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { EmptyCard, LoadingRow, Mono, PageHeader, SectionCard } from "../components/bits.tsx";
import { Chip } from "../components/ent-bits.tsx";
import { ToggleSwitch } from "../components/primitives.tsx";
import { PricingCards } from "../components/pricing.tsx";
import type { CatalogView as CatalogData, NormalizedPlan } from "../types.ts";

const KIND_LABEL: Record<string, string> = {
  boolean: "boolean",
  metered: "metered",
  credits: "credits",
  capacity: "capacity",
  value: "value",
};

/**
 * The catalog as the engine sees it (read-only — the catalog is code, ADR 0002):
 * features × plans, add-ons, provider mappings, and the public pricing preview.
 */
export function CatalogView() {
  const catalog = useCatalog();
  const [showVersions, setShowVersions] = React.useState(false);
  const [showHidden, setShowHidden] = React.useState(false);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader
        title="Catalog"
        description="Features, plans and add-ons declared in code. Read-only here: edit the catalog file and redeploy."
      />
      {catalog.isLoading ? (
        <LoadingRow label="Loading catalog…" />
      ) : catalog.isError || !catalog.data ? (
        <EmptyCard>Failed to load the catalog.</EmptyCard>
      ) : (
        <CatalogBody
          data={catalog.data.view}
          showVersions={showVersions}
          showHidden={showHidden}
          setShowVersions={setShowVersions}
          setShowHidden={setShowHidden}
        />
      )}
    </div>
  );
}

function CatalogBody({
  data,
  showVersions,
  showHidden,
  setShowVersions,
  setShowHidden,
}: {
  data: CatalogData;
  showVersions: boolean;
  showHidden: boolean;
  setShowVersions: (v: boolean) => void;
  setShowHidden: (v: boolean) => void;
}) {
  const plans = data.plans.filter((p) => (showVersions || p.current) && (showHidden || !p.hidden));
  const hiddenCount = new Set(data.plans.filter((p) => p.hidden).map((p) => p.key)).size;
  const previousCount = data.plans.filter((p) => !p.current).length;
  const publicPricing = {
    ...data.pricing,
    plans: data.pricing.plans.filter(
      (p) => !data.plans.find((x) => x.key === p.key && x.current)?.hidden,
    ),
  };
  const providerRows = data.plans
    .filter((p) => showVersions || p.current)
    .flatMap((p) =>
      Object.entries(p.providers).map(([provider, ids]) => ({
        key: `${p.key}@${p.version}:${provider}`,
        target: p.name,
        targetKey: p.key,
        version: p.version,
        current: p.current,
        provider,
        ids: [...ids],
      })),
    )
    .concat(
      data.addons.flatMap((a) =>
        Object.entries(a.providers).map(([provider, ids]) => ({
          key: `addon:${a.key}:${provider}`,
          target: a.name,
          targetKey: a.key,
          version: 0,
          current: true,
          provider,
          ids: [...ids],
        })),
      ),
    );

  return (
    <>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Count label="Features" value={data.features.length} />
        <Count label="Plans" value={new Set(data.plans.map((p) => p.key)).size} />
        <Count label="Plan versions" value={data.plans.length} />
        <Count label="Add-ons" value={data.addons.length} />
      </div>

      <SectionCard
        className="mt-6"
        title="Features × plans"
        description="What each plan includes. Limits are per reset window."
        actions={
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <label className="flex items-center gap-2">
              <ToggleSwitch
                checked={showVersions}
                onCheckedChange={setShowVersions}
                aria-label="Show previous versions"
                disabled={previousCount === 0}
              />
              Previous versions
              {previousCount > 0 ? <span className="tabular-nums">({previousCount})</span> : null}
            </label>
            <label className="flex items-center gap-2">
              <ToggleSwitch
                checked={showHidden}
                onCheckedChange={setShowHidden}
                aria-label="Show hidden plans"
                disabled={hiddenCount === 0}
              />
              Hidden plans
              {hiddenCount > 0 ? <span className="tabular-nums">({hiddenCount})</span> : null}
            </label>
          </div>
        }
        flush
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border">
                <th className="sticky left-0 z-[1] w-56 bg-card px-4 py-3 text-left align-bottom text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Feature
                </th>
                {plans.map((p) => (
                  <PlanHeader key={`${p.key}@${p.version}`} plan={p} />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.features.map((f) => (
                <tr key={f.key} className="hover:bg-secondary/25">
                  <th
                    scope="row"
                    className="sticky left-0 z-[1] bg-card px-4 py-2.5 text-left align-top font-normal"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-foreground">{f.name}</span>
                      {f.hidden ? (
                        <EyeOff className="size-3 text-muted-foreground" aria-label="hidden" />
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Mono className="text-[11px] text-muted-foreground">{f.key}</Mono>
                      <Chip className="px-1 py-0 text-[10px]">{KIND_LABEL[f.kind]}</Chip>
                      {f.reset && f.reset !== "never" ? (
                        <span className="text-[10.5px] text-muted-foreground">
                          {resetLabel(f.reset)}
                        </span>
                      ) : null}
                    </div>
                  </th>
                  {plans.map((p) => {
                    const cell = entryLabel(f, p.features[f.key]);
                    return (
                      <td
                        key={`${p.key}@${p.version}`}
                        className={cn(
                          "px-4 py-2.5 align-top",
                          !p.current && "bg-secondary/20",
                          p.highlight && p.current && "bg-accent/[0.04]",
                        )}
                      >
                        <span
                          className={cn(
                            "tabular-nums",
                            cell.included
                              ? cell.label === "✓"
                                ? "font-semibold text-accent"
                                : "text-foreground"
                              : "text-muted-foreground/60",
                          )}
                        >
                          {cell.label}
                        </span>
                        {cell.detail ? (
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {cell.detail}
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Add-ons" description="Stack on top of a plan." flush>
          {data.addons.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">No add-ons.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.addons.map((a) => (
                <li key={a.key} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground">
                        {a.name}{" "}
                        <Mono className="ml-1 text-[11px] text-muted-foreground">{a.key}</Mono>
                      </p>
                      {a.description ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">{a.description}</p>
                      ) : null}
                    </div>
                    <span className="whitespace-nowrap text-[13px] tabular-nums text-foreground">
                      {formatPrice(a.price)}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {Object.entries(a.features).map(([fk, e]) => {
                      const f = data.features.find((x) => x.key === fk);
                      const label =
                        e.kind === "boolean"
                          ? "enabled"
                          : e.kind === "value"
                            ? JSON.stringify(e.value)
                            : e.add === null
                              ? "unlimited"
                              : `+${e.add.toLocaleString("en-US")}`;
                      return (
                        <Chip key={fk} accent>
                          {f?.name ?? fk}: {label}
                        </Chip>
                      );
                    })}
                    {a.quantity ? (
                      <Chip>per unit{a.maxQuantity ? ` · max ${a.maxQuantity}` : ""}</Chip>
                    ) : null}
                    {a.requires.length ? <Chip>requires {a.requires.join(" or ")}</Chip> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Provider mappings"
          description="Billing-provider price / product ids that map to each plan."
          flush
        >
          {providerRows.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">
              No provider mappings — plans are assigned manually.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2.5 font-semibold">Plan</th>
                    <th className="px-4 py-2.5 font-semibold">Provider</th>
                    <th className="px-4 py-2.5 font-semibold">Item ids</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {providerRows.map((r) => (
                    <tr key={r.key} className={cn(!r.current && "text-muted-foreground")}>
                      <td className="px-4 py-2.5 align-top">
                        {r.target}
                        {r.version > 0 ? (
                          <span className="ml-1 text-xs text-muted-foreground">v{r.version}</span>
                        ) : (
                          <span className="ml-1 text-xs text-muted-foreground">add-on</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <Chip>{r.provider}</Chip>
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <div className="flex flex-col gap-0.5">
                          {r.ids.map((id) => (
                            <Mono key={id} className="text-[11.5px]">
                              {id}
                            </Mono>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        className="mt-4"
        title="Pricing preview"
        description={
          <>
            What <Mono className="text-[11px]">GET /api/pricing</Mono> and{" "}
            <Mono className="text-[11px]">&lt;PricingTable&gt;</Mono> render (hidden plans
            excluded).
          </>
        }
      >
        <PricingCards pricing={publicPricing} />
      </SectionCard>
    </>
  );
}

function PlanHeader({ plan }: { plan: NormalizedPlan }) {
  return (
    <th
      scope="col"
      className={cn(
        "min-w-36 px-4 py-3 text-left align-bottom font-normal",
        !plan.current && "bg-secondary/20",
        plan.highlight && plan.current && "bg-accent/[0.04]",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[13px] font-semibold text-foreground">{plan.name}</span>
        {plan.highlight ? (
          <Star className="size-3 fill-accent text-accent" aria-label="highlighted" />
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Chip className="px-1 py-0 text-[10px]" accent={plan.current}>
          v{plan.version}
          {plan.current ? "" : " · legacy"}
        </Chip>
        {plan.default ? <Chip className="px-1 py-0 text-[10px]">default</Chip> : null}
        {plan.hidden ? <Chip className="px-1 py-0 text-[10px]">hidden</Chip> : null}
        {plan.trialDays ? (
          <Chip className="px-1 py-0 text-[10px]">{plan.trialDays}d trial</Chip>
        ) : null}
      </div>
      <p className="mt-1 text-xs tabular-nums text-muted-foreground">{formatPrice(plan.price)}</p>
    </th>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{value}</p>
    </div>
  );
}
