import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { listActivity } from "../api.ts";
import { keys } from "../lib/queries.ts";
import { ActivityTimeline } from "../components/activity.tsx";
import { EmptyCard, LoadingRow, PageHeader, Segmented, TextInput } from "@xtandard/kit/ui";

type Filter = "all" | "subscription" | "grant" | "override" | "usage" | "customer";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "subscription", label: "Plans" },
  { value: "grant", label: "Grants" },
  { value: "override", label: "Overrides" },
  { value: "usage", label: "Usage" },
  { value: "customer", label: "Customers" },
];

const matches = (type: string, filter: Filter): boolean =>
  filter === "all" ||
  (filter === "subscription"
    ? type.startsWith("subscription") || type.startsWith("trial") || type.startsWith("plan")
    : type.startsWith(filter));

/** The global control-plane log: every change, newest first. */
export function ActivityView({ onOpenCustomer }: { onOpenCustomer: (id: string) => void }) {
  const activity = useQuery({
    queryKey: keys.activity,
    queryFn: () => listActivity(200),
    staleTime: 5_000,
  });
  const [filter, setFilter] = React.useState<Filter>("all");
  const [search, setSearch] = React.useState("");
  const term = search.trim().toLowerCase();
  const entries = (activity.data ?? []).filter(
    (e) =>
      matches(e.type, filter) &&
      (!term || e.customer.toLowerCase().includes(term) || e.summary.toLowerCase().includes(term)),
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader
        title="Activity"
        description="Every control-plane change — plans, grants, overrides, usage corrections — and who made it."
      />
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={filter} onValueChange={setFilter} options={FILTERS} />
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <TextInput
            type="search"
            aria-label="Filter activity"
            placeholder="Filter by customer or text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
      </div>
      {activity.isLoading ? (
        <LoadingRow label="Loading activity…" />
      ) : activity.isError ? (
        <EmptyCard>Failed to load activity.</EmptyCard>
      ) : entries.length === 0 ? (
        <EmptyCard>
          {activity.data?.length ? "Nothing matches this filter." : "No activity yet."}
        </EmptyCard>
      ) : (
        <div className="mt-4 rounded-xl border border-border bg-card px-4 pt-4 shadow-sm">
          <ActivityTimeline entries={entries} showCustomer onOpenCustomer={onOpenCustomer} />
        </div>
      )}
    </div>
  );
}
