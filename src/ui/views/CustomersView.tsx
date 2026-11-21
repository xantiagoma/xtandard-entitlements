import React from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { listCustomers } from "../api.ts";
import { formatDateTime, initials, relativeTime } from "../lib/format.ts";
import { keys, useCatalog } from "../lib/queries.ts";
import { EmptyCard, LoadingRow, Mono, PageHeader } from "../components/bits.tsx";
import { Chip, StatusBadge } from "../components/ent-bits.tsx";
import { TextInput } from "../components/primitives.tsx";
import { Avatar, Button } from "../components/ui-bits.tsx";

const PAGE_SIZE = 20;

/** Debounce a value (search-as-you-type). */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Searchable, cursor-paginated customer list. */
export function CustomersView({ onOpen }: { onOpen: (id: string) => void }) {
  const [search, setSearch] = React.useState("");
  const term = useDebounced(search.trim(), 250);
  // Cursor stack: [undefined (page 1), cursor of page 2, …].
  const [cursors, setCursors] = React.useState<Array<string | undefined>>([undefined]);
  const after = cursors[cursors.length - 1];
  React.useEffect(() => setCursors([undefined]), [term]);

  const page = useQuery({
    queryKey: [...keys.customers, { term, after }],
    queryFn: () => listCustomers({ search: term || undefined, limit: PAGE_SIZE, after }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const catalog = useCatalog();
  const planName = (k: string) => catalog.data?.planName(k) ?? k;
  const customers = page.data?.customers ?? [];
  const pageNo = cursors.length;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader
        title="Customers"
        description="Everyone with entitlement state: plans, subscriptions and overrides."
      />

      <div className="mt-6 flex items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <TextInput
            type="search"
            aria-label="Search customers"
            placeholder="Search by id, name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        {page.isFetching && !page.isLoading ? (
          <span className="text-xs text-muted-foreground">Loading…</span>
        ) : null}
      </div>

      {page.isLoading ? (
        <LoadingRow label="Loading customers…" />
      ) : page.isError ? (
        <EmptyCard>Failed to load customers.</EmptyCard>
      ) : customers.length === 0 ? (
        <EmptyCard>
          {term ? (
            <>
              No customers match <span className="font-medium text-foreground">“{term}”</span>.
            </>
          ) : (
            "No customers yet. State is created on a customer's first subscription, grant or override."
          )}
        </EmptyCard>
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5 font-semibold">Customer</th>
                  <th className="px-4 py-2.5 font-semibold">Plans</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {customers.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer transition-colors hover:bg-secondary/35"
                    onClick={() => onOpen(c.id)}
                  >
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(c.id);
                        }}
                        className="flex items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Avatar initials={initials(c.name ?? c.id)} className="size-7" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-foreground">
                            {c.name ?? c.id}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            <Mono className="text-[11px] text-muted-foreground">{c.id}</Mono>
                            {c.email ? ` · ${c.email}` : ""}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {c.plans.length === 0 ? (
                          <span className="text-xs text-muted-foreground">default</span>
                        ) : (
                          c.plans.map((p) => (
                            <Chip key={p} accent={!catalog.data?.plan(p)?.default}>
                              {planName(p)}
                            </Chip>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {c.statuses.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          [...new Set(c.statuses)].map((s) => <StatusBadge key={s} status={s} />)
                        )}
                      </div>
                    </td>
                    <td
                      className="whitespace-nowrap px-4 py-2.5 text-right text-xs tabular-nums text-muted-foreground"
                      title={formatDateTime(c.updatedAt)}
                    >
                      {relativeTime(c.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
            <span className="text-xs text-muted-foreground">
              Page {pageNo} · {customers.length} customer{customers.length === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                disabled={pageNo === 1}
                onClick={() => setCursors((c) => c.slice(0, -1))}
                icon={<ChevronLeft className="size-3.5" />}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!page.data?.next}
                onClick={() => {
                  const next = page.data?.next;
                  if (next) setCursors((c) => [...c, next]);
                }}
              >
                Next
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
