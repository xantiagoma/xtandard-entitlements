/**
 * The SPA's client for the panel's JSON API (docs/HTTP_API.md). Paths are
 * relative (resolved against the injected `<base href>`) unless the React embed
 * points the client elsewhere with {@link setApiBase}. A portal token set with
 * {@link setApiToken} rides along as `Authorization: Bearer entpt_…`.
 *
 * @module
 */

import type {
  ActivityEntry,
  CatalogView,
  CheckResult,
  CustomerDetail,
  CustomerPage,
  CustomerState,
  Grant,
  GrantInput,
  Override,
  OverrideInput,
  Overview,
  PanelConfig,
  PortalView,
  PricingTable,
  SeriesPoint,
  SubscribeInput,
  Subscription,
} from "./types.ts";
import { EntitlementsApiError, type ApiErrorBody } from "./types.ts";

// Base prepended to every request path. Empty by default so the bundled SPA uses
// relative URLs (resolved against the injected <base href>). The React embed
// sets this to the panel's mount URL via setApiBase().
let apiBase = "";
// `same-origin` (default) suits the bundled SPA and same-origin embeds; a
// cross-origin embed with cookie auth must use `include`.
let apiCredentials: RequestCredentials = "same-origin";
let apiFetch: FetchLike = (input, init) => fetch(input, init);
// Portal token sent as `Authorization: Bearer entpt_…` on every request.
let apiToken: string | null = null;
// Admin preview of a customer's portal: `?customer=` on the portal routes.
let previewCustomer: string | null = null;

/** The subset of `fetch` the client uses (the global `fetch` satisfies it). */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Options for {@link setApiBase}. */
export interface ApiClientOptions {
  /** `credentials` mode for requests. Use `"include"` for cross-origin cookie auth. */
  credentials?: RequestCredentials;
  /** Custom fetch implementation (bearer tokens, extra headers, instrumentation). */
  fetch?: FetchLike;
}

/** Point the API client at a base URL (used by `@xtandard/entitlements/react/embed`). */
export function setApiBase(base: string, opts?: ApiClientOptions): void {
  apiBase = base.replace(/\/$/, "");
  if (opts?.credentials) apiCredentials = opts.credentials;
  if (opts?.fetch) apiFetch = opts.fetch;
}

/** Attach a portal token (`entpt_…`) as a Bearer credential on every request. */
export function setApiToken(token: string | null): void {
  apiToken = token;
}

/** The portal token currently attached, if any. */
export function getApiToken(): string | null {
  return apiToken;
}

/**
 * Admin preview: send `?customer=<id>` on the portal routes so an admin
 * principal sees that customer's portal. `null` to clear.
 */
export function setPreviewCustomer(customer: string | null): void {
  previewCustomer = customer;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(apiBase ? `${apiBase}/${path}` : path, {
    credentials: apiCredentials,
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let body: ApiErrorBody;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = { error: res.statusText || `HTTP ${res.status}` };
    }
    throw new EntitlementsApiError(res.status, body);
  }

  const text = await res.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const query = (params: { [key: string]: string | number | undefined | null }): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
};

const enc = encodeURIComponent;
const customerBase = (id: string): string => `api/customers/${enc(id)}`;

/* ─── Panel ─────────────────────────────────────────────────────────────────── */

export function getConfig(): Promise<PanelConfig> {
  return req<PanelConfig>("config");
}

export function getCatalog(): Promise<CatalogView> {
  return req<CatalogView>("api/catalog");
}

export function getPricing(): Promise<PricingTable> {
  return req<PricingTable>("api/pricing");
}

export function getOverview(): Promise<Overview> {
  return req<Overview>("api/overview");
}

export function listActivity(limit = 100): Promise<ActivityEntry[]> {
  return req<ActivityEntry[]>(`api/activity${query({ limit })}`);
}

/* ─── Customers ─────────────────────────────────────────────────────────────── */

export function listCustomers(
  params: { search?: string; limit?: number; after?: string } = {},
): Promise<CustomerPage> {
  return req<CustomerPage>(`api/customers${query(params)}`);
}

export function getCustomer(id: string): Promise<CustomerDetail> {
  return req<CustomerDetail>(customerBase(id));
}

export function updateCustomer(
  id: string,
  patch: { name?: string; email?: string },
): Promise<CustomerState> {
  return req<CustomerState>(customerBase(id), send("PATCH", patch));
}

export function deleteCustomer(id: string): Promise<void> {
  return req<void>(customerBase(id), send("DELETE"));
}

export function customerActivity(id: string, limit = 50): Promise<ActivityEntry[]> {
  return req<ActivityEntry[]>(`${customerBase(id)}/activity${query({ limit })}`);
}

/* ─── Subscriptions ─────────────────────────────────────────────────────────── */

export function subscribe(id: string, input: SubscribeInput): Promise<Subscription> {
  return req<Subscription>(`${customerBase(id)}/subscriptions`, send("POST", input));
}

export function updateSubscription(
  id: string,
  sid: string,
  patch: { cancelAtPeriodEnd?: boolean; quantity?: number; status?: string },
): Promise<Subscription> {
  return req<Subscription>(`${customerBase(id)}/subscriptions/${enc(sid)}`, send("PATCH", patch));
}

export function cancelSubscription(
  id: string,
  sid: string,
  atPeriodEnd: boolean,
): Promise<Subscription> {
  return req<Subscription>(
    `${customerBase(id)}/subscriptions/${enc(sid)}/cancel`,
    send("POST", { atPeriodEnd }),
  );
}

export function removeSubscription(id: string, sid: string): Promise<void> {
  return req<void>(`${customerBase(id)}/subscriptions/${enc(sid)}`, send("DELETE"));
}

export function startTrial(
  id: string,
  input: { plan: string; days?: number; force?: boolean },
): Promise<Subscription> {
  return req<Subscription>(`${customerBase(id)}/trials`, send("POST", input));
}

export function migratePlan(
  plan: string,
  input: { toVersion?: number; customer?: string },
): Promise<{ migrated: number }> {
  return req<{ migrated: number }>(`api/plans/${enc(plan)}/migrate`, send("POST", input));
}

/* ─── Grants, overrides, usage ──────────────────────────────────────────────── */

export function addGrant(id: string, input: GrantInput): Promise<Grant> {
  return req<Grant>(`${customerBase(id)}/grants`, send("POST", input));
}

export function revokeGrant(id: string, gid: string): Promise<void> {
  return req<void>(`${customerBase(id)}/grants/${enc(gid)}`, send("DELETE"));
}

export function addOverride(id: string, input: OverrideInput): Promise<Override> {
  return req<Override>(`${customerBase(id)}/overrides`, send("POST", input));
}

export function removeOverride(id: string, oid: string): Promise<void> {
  return req<void>(`${customerBase(id)}/overrides/${enc(oid)}`, send("DELETE"));
}

export function setUsage(id: string, feature: string, value: number): Promise<CheckResult> {
  return req<CheckResult>(`${customerBase(id)}/usage/${enc(feature)}`, send("PUT", { value }));
}

export function resetUsage(id: string, feature: string): Promise<void> {
  return req<void>(`${customerBase(id)}/usage/${enc(feature)}`, send("DELETE"));
}

export function usageSeries(id: string, feature: string, days = 30): Promise<SeriesPoint[]> {
  return req<SeriesPoint[]>(`${customerBase(id)}/usage/${enc(feature)}/series${query({ days })}`);
}

/* ─── Portal ────────────────────────────────────────────────────────────────── */

const portalQuery = (): string => query({ customer: previewCustomer });

export function getPortal(): Promise<PortalView> {
  return req<PortalView>(`api/portal/me${portalQuery()}`);
}

export function portalCheckout(input: {
  plan: string;
  quantity?: number;
  successUrl?: string;
  cancelUrl?: string;
}): Promise<{ url: string }> {
  return req<{ url: string }>(`api/portal/checkout${portalQuery()}`, send("POST", input));
}

export function portalManage(input: { returnUrl?: string } = {}): Promise<{ url: string }> {
  return req<{ url: string }>(`api/portal/manage${portalQuery()}`, send("POST", input));
}
