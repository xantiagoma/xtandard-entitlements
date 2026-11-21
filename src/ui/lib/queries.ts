/**
 * Shared TanStack Query hooks and cache keys for the views.
 *
 * @module
 */

import { useQuery } from "@tanstack/react-query";
import { getCatalog } from "../api.ts";
import type { CatalogView, NormalizedFeature, NormalizedPlan } from "../types.ts";

/** Cache keys (invalidate by prefix after mutations). */
export const keys = {
  config: ["config"] as const,
  catalog: ["catalog"] as const,
  overview: ["overview"] as const,
  activity: ["activity"] as const,
  customers: ["customers"] as const,
  customer: (id: string) => ["customer", id] as const,
  customerActivity: (id: string) => ["customer", id, "activity"] as const,
  series: (id: string, feature: string) => ["customer", id, "series", feature] as const,
  portal: (customer: string | null) => ["portal", customer ?? ""] as const,
};

/** The catalog, indexed for lookups (feature by key, current plan by key). */
export interface CatalogIndex {
  view: CatalogView;
  feature: (key: string) => NormalizedFeature | undefined;
  /** The current version of a plan (or an add-on rendered as a plan-like row). */
  plan: (key: string) => NormalizedPlan | undefined;
  /** A plan's display name (falls back to the key, also for add-ons). */
  planName: (key: string) => string;
}

/** Build a {@link CatalogIndex} from the catalog view. */
export function indexCatalog(view: CatalogView): CatalogIndex {
  const features = new Map(view.features.map((f) => [f.key, f]));
  const plans = new Map<string, NormalizedPlan>();
  for (const p of view.plans) if (p.current) plans.set(p.key, p);
  const addons = new Map(view.addons.map((a) => [a.key, a]));
  return {
    view,
    feature: (key) => features.get(key),
    plan: (key) => plans.get(key),
    planName: (key) => plans.get(key)?.name ?? addons.get(key)?.name ?? key,
  };
}

/** The admin catalog (`GET /api/catalog`), indexed. Cached for the session. */
export function useCatalog() {
  return useQuery({
    queryKey: keys.catalog,
    queryFn: getCatalog,
    staleTime: 5 * 60_000,
    select: indexCatalog,
  });
}
