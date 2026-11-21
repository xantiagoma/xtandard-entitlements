/**
 * The panel's JSON API (docs/HTTP_API.md is the contract). A tiny
 * method + pattern router over the engine, wired to authentication,
 * authorization, portal-token scoping and valibot input validation. Returns
 * `null` for non-API paths so the caller can fall through to static assets /
 * the SPA.
 *
 * Every route is one entry of {@link API_ROUTES}: method, path, the
 * authorization action and resource, and the handler. The OpenAPI document is
 * generated from the same table, so the two cannot drift.
 *
 * The customer **portal** is not a separate server: a request bearing a valid
 * `Authorization: Bearer entpt_…` token hits this same API as a portal
 * principal, force-scoped to the token's customer and to the token's portal
 * actions (the host's authorization provider is bypassed — ADR 0010). Admin
 * principals may call the portal routes with `?customer=<id>` (preview).
 *
 * @module
 */

import type { AuthProvider, Principal } from "../auth/contract.ts";
import {
  isMutatingAction,
  type AuthorizationProvider,
  type EntitlementsAction,
  type EntitlementsResource,
} from "../authorization/contract.ts";
import { BillingVerificationError, type EntitlementsBilling } from "../billing/contract.ts";
import type {
  AnyCatalog,
  NormalizedAddon,
  NormalizedFeature,
  NormalizedPlan,
  PricingTable,
} from "../catalog.ts";
import {
  EntitlementsValidationError,
  NotFoundError,
  ReadonlyError,
  type Entitlements,
} from "../engine.ts";
import { HookDeniedError } from "../hooks/contract.ts";
import { customersPrefix, lastSegment, reservationKey } from "../keys.ts";
import { PORTAL_TOKEN_PREFIX, PortalTokenError, verifyPortalToken } from "../portal.ts";
import { resolveEntitlements } from "../resolve.ts";
import type {
  ActivityEntry,
  Actor,
  CustomerEntitlements,
  CustomerState,
  Reservation,
  SubscriptionStatus,
} from "../schema.ts";
import {
  cancelSchema,
  customerPatchSchema,
  grantSchema,
  migrateSchema,
  overrideSchema,
  parseInput,
  portalCheckoutSchema,
  portalManageSchema,
  reconcileSchema,
  runtimeCheckSchema,
  runtimeConsumeSchema,
  runtimeReleaseSchema,
  runtimeReserveSchema,
  runtimeSettleSchema,
  setUsageSchema,
  subscribeSchema,
  subscriptionPatchSchema,
  trialSchema,
} from "../validation.ts";
import type { GenericSchema, InferOutput } from "valibot";

/** Portal composition for the panel: verifies `entpt_…` bearer tokens (ADR 0010). */
export interface EntitlementsPortalOptions {
  /** The HMAC secret portal tokens are minted with (`createPortalToken`). */
  secret: string;
}

/** Everything the API router needs. */
export interface ApiContext {
  engine: Entitlements<AnyCatalog>;
  /** Billing intake (webhooks, reconcile, portal link-outs). Optional. */
  billing?: EntitlementsBilling;
  auth: AuthProvider;
  authorization: AuthorizationProvider;
  title: string;
  readonly: boolean;
  basePath: string;
  logoUrl?: string;
  /** Portal-token composition (see {@link EntitlementsPortalOptions}). */
  portal?: EntitlementsPortalOptions;
  /** Clock for `/api/overview` windows. Default `Date.now`. */
  now?: () => number;
}

/** `GET /config` — the SPA bootstrap (public). */
export interface PanelConfig {
  title: string;
  logoUrl?: string;
  basePath: string;
  readonly: boolean;
  /** `"portal"` for portal-token requests (the SPA renders the reduced customer chrome). */
  mode: "admin" | "portal";
  authenticated: boolean;
  principal: { id: string; name?: string; email?: string; roles?: string[] } | null;
  /** Portal mode: the token's customer. */
  customer?: string;
  /** Portal mode: the token's granted portal actions. */
  scope?: EntitlementsAction[];
  /** Configured billing provider ids (reconcile / link-outs). */
  billingProviders: string[];
}

/** `GET /api/catalog`. */
export interface CatalogView {
  /** In declaration order. */
  features: NormalizedFeature[];
  /** Every version, current first per plan, in plan order. */
  plans: NormalizedPlan[];
  addons: NormalizedAddon[];
  /** Including hidden plans (admin view). */
  pricing: PricingTable;
}

/** `GET /api/overview`. */
export interface Overview {
  customers: number;
  /** Entitled plan key → customers (default plans included). */
  byPlan: Record<string, number>;
  /** Subscription status → subscriptions. */
  statuses: Record<SubscriptionStatus, number>;
  /** Trials ending in the next 7 days, soonest first. */
  trialsEndingSoon: Array<{ customer: string; plan: string; trialEndsAt: string }>;
  /** Newest first, max 20. */
  recentActivity: ActivityEntry[];
}

/** `GET /api/portal/me`. */
export interface PortalView extends CustomerEntitlements {
  profile: { id: string; name?: string; email?: string };
  /** Public pricing (hidden plans excluded). */
  pricing: PricingTable;
  /** A billing provider with `createCheckout` is configured (and the token allows it). */
  canCheckout: boolean;
  /** … with `createPortalSession`. */
  canManage: boolean;
}

/** Route tags (OpenAPI grouping). */
export type RouteTag =
  | "panel"
  | "catalog"
  | "customers"
  | "subscriptions"
  | "grants"
  | "overrides"
  | "usage"
  | "activity"
  | "runtime"
  | "portal"
  | "billing";

/** HTTP methods the router serves. */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A query parameter a route documents. */
export interface RouteQueryParam {
  name: string;
  type: "string" | "integer";
  description: string;
}

/** The documented shape of one route (consumed by the OpenAPI builder). */
export interface RouteSpec {
  method: RouteMethod;
  /** Pattern with `:name` segments, base-path-relative. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: RouteTag;
  /** Authorization action; absent = public (no authentication). */
  action?: EntitlementsAction;
  query?: RouteQueryParam[];
  /** Component schema name of the JSON request body. */
  body?: string;
  /** Whether the body is required (default `true` when `body` is set). */
  bodyRequired?: boolean;
  /** Success status, component schema name (or inline JSON schema), description. */
  response: { status: number; schema?: string | Record<string, unknown>; description: string };
}

/** Per-request state handed to route handlers. */
interface Call {
  request: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  ctx: ApiContext;
  engine: Entitlements<AnyCatalog>;
  principal: Principal | null;
  actor: Actor | null;
  /** Portal routes: the customer the call is scoped to. */
  portalCustomer?: string;
  /** Portal principals: their scope. `null` for admin principals. */
  portalScope: ReadonlySet<EntitlementsAction> | null;
  /** Parse + validate the JSON body (an empty body is `{}`). Memoized. */
  body<S extends GenericSchema>(schema: S): Promise<InferOutput<S>>;
}

interface ApiRoute extends RouteSpec {
  resource?(call: Call): EntitlementsResource | Promise<EntitlementsResource>;
  handle(call: Call): Promise<Response> | Response;
}

const json = (data: unknown, status = 200, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const methodNotAllowed = (allow: Iterable<string>): Response =>
  json({ error: "Method Not Allowed" }, 405, { allow: [...allow].join(", ") });

const noContent = (): Response => new Response(null, { status: 204 });

const error = (status: number, message: string, extra?: Record<string, unknown>): Response =>
  json({ error: message, ...extra }, status);

/** Thrown inside the router to short-circuit with a response. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Match `pattern` (with `:name` segments) against `path`. */
function match(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split("/").filter(Boolean);
  const ap = path.split("/").filter(Boolean);
  if (pp.length !== ap.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    const val = ap[i]!;
    if (seg.startsWith(":")) {
      try {
        params[seg.slice(1)] = decodeURIComponent(val);
      } catch {
        return null;
      }
    } else if (seg !== val) return null;
  }
  return params;
}

/** Parse a positive-integer query param, or `undefined`. */
function intParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpError(
      400,
      `Invalid query parameter: expected a positive integer, got "${value}"`,
    );
  }
  return Math.floor(n);
}

/** Build the activity {@link Actor} for a principal. */
function actorFor(principal: Principal, portalCustomer?: string): Actor {
  if (portalCustomer !== undefined) return { id: principal.id, type: "portal" };
  return {
    id: principal.id,
    type: "user",
    ...(principal.email !== undefined ? { email: principal.email } : {}),
    ...(principal.name !== undefined ? { name: principal.name } : {}),
  };
}

const requireBilling = (ctx: ApiContext): EntitlementsBilling => {
  if (!ctx.billing) throw new HttpError(404, "Billing is not configured");
  return ctx.billing;
};

/** The admin catalog view (every plan version, hidden plans included). */
export function catalogView(engine: Entitlements<AnyCatalog>): CatalogView {
  const n = engine.catalog.normalized;
  const versions = [...n.planVersions.values()];
  return {
    features: n.featureOrder.map((k) => n.features.get(k)!),
    plans: n.planOrder.flatMap((key) =>
      versions
        .filter((p) => p.key === key)
        .sort((a, b) => Number(b.current) - Number(a.current) || b.version - a.version),
    ),
    addons: n.addonOrder.map((k) => n.addons.get(k)!),
    pricing: engine.pricing({ includeHidden: true }),
  };
}

const ALL_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
  "paused",
  "canceled",
  "incomplete",
];

const WEEK = 7 * 86_400_000;

/**
 * The admin overview. Walks every stored customer (fine for admin dashboards;
 * O(customers) state reads).
 */
export async function buildOverview(
  engine: Entitlements<AnyCatalog>,
  now: number = Date.now(),
): Promise<Overview> {
  const ids = (await engine.storage.getKeys(customersPrefix())).map((k) => lastSegment(k));
  const byPlan: Record<string, number> = {};
  const statuses = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
    SubscriptionStatus,
    number
  >;
  const trialsEndingSoon: Overview["trialsEndingSoon"] = [];
  let customers = 0;
  for (const id of ids) {
    const state = await engine.getCustomer(id);
    if (!state) continue;
    customers++;
    const set = resolveEntitlements(engine.catalog, state, now);
    for (const p of new Set(set.plans.map((p) => p.plan))) byPlan[p] = (byPlan[p] ?? 0) + 1;
    for (const sub of state.subscriptions) {
      statuses[sub.status] = (statuses[sub.status] ?? 0) + 1;
      if (sub.status === "trialing" && sub.trialEndsAt) {
        const end = Date.parse(sub.trialEndsAt);
        if (end >= now && end <= now + WEEK) {
          trialsEndingSoon.push({ customer: id, plan: sub.plan, trialEndsAt: sub.trialEndsAt });
        }
      }
    }
  }
  trialsEndingSoon.sort((a, b) => Date.parse(a.trialEndsAt) - Date.parse(b.trialEndsAt));
  const recentActivity = await engine.activity(undefined, { limit: 20 });
  return { customers, byPlan, statuses, trialsEndingSoon, recentActivity };
}

const customerRes = (c: Call): EntitlementsResource => ({
  type: "customer",
  customer: c.params.id!,
});
const subRes = (c: Call): EntitlementsResource => ({
  type: "subscription",
  customer: c.params.id!,
  ...(c.params.sid !== undefined ? { id: c.params.sid } : {}),
});
const usageRes = (c: Call): EntitlementsResource => ({
  type: "usage",
  customer: c.params.id!,
  feature: c.params.feature!,
});
const portalRes = (c: Call): EntitlementsResource => ({
  type: "portal",
  customer: c.portalCustomer!,
});

const LIMIT: RouteQueryParam = {
  name: "limit",
  type: "integer",
  description: "Maximum entries (default 50).",
};
const PREVIEW: RouteQueryParam = {
  name: "customer",
  type: "string",
  description: "Admin principals only: the customer whose portal to preview.",
};

/**
 * The route table — every route of the HTTP API (docs/HTTP_API.md), in match
 * order. Exposed for the OpenAPI builder and tests.
 */
const ROUTES: ApiRoute[] = [
  // --- Public ---------------------------------------------------------------
  {
    method: "GET",
    path: "/healthcheck",
    operationId: "healthcheck",
    summary: "Liveness probe",
    tag: "panel",
    response: { status: 200, schema: "Health", description: "Alive" },
    handle: () => json({ ok: true }),
  },
  {
    method: "GET",
    path: "/api/openapi.json",
    operationId: "getOpenApi",
    summary: "This OpenAPI 3.1 document",
    tag: "panel",
    response: { status: 200, schema: { type: "object" }, description: "OpenAPI 3.1" },
    // Answered by the handler factory (it owns the document); see handleApiRequest.
    handle: () => error(500, "unreachable"),
  },
  {
    method: "GET",
    path: "/api/pricing",
    operationId: "getPricing",
    summary: "Public pricing table (hidden plans excluded; CORS *)",
    tag: "catalog",
    response: { status: 200, schema: "PricingTable", description: "Pricing table" },
    handle: (c) => json(c.engine.pricing(), 200, { "access-control-allow-origin": "*" }),
  },
  {
    method: "POST",
    path: "/webhooks/:provider",
    operationId: "billingWebhook",
    summary: "Billing provider webhook intake (signature-verified, no auth)",
    description:
      "Answered by the configured billing intake. The provider signature is the credential. `404` when billing is not configured or the provider is unknown; `400` for a bad signature or payload.",
    tag: "billing",
    response: { status: 200, schema: "WebhookReceipt", description: "Processed or ignored" },
    async handle(c) {
      const billing = requireBilling(c.ctx);
      const { outcome } = await billing.handleWebhook(c.params.provider!, c.request);
      return json({ received: true, outcome });
    },
  },

  // --- Admin: catalog + overview ----------------------------------------------
  {
    method: "GET",
    path: "/api/catalog",
    operationId: "getCatalog",
    summary: "Catalog view: features, every plan version, add-ons, pricing",
    tag: "catalog",
    action: "catalog:read",
    resource: () => ({ type: "catalog" }),
    response: { status: 200, schema: "CatalogView", description: "Catalog" },
    handle: (c) => json(catalogView(c.engine)),
  },
  {
    method: "GET",
    path: "/api/overview",
    operationId: "getOverview",
    summary: "Admin overview: customers by plan, statuses, trials ending, recent activity",
    tag: "customers",
    action: "customer:read",
    resource: () => ({ type: "customer" }),
    response: { status: 200, schema: "Overview", description: "Overview" },
    handle: async (c) => json(await buildOverview(c.engine, (c.ctx.now ?? Date.now)())),
  },

  // --- Admin: customers -------------------------------------------------------
  {
    method: "GET",
    path: "/api/customers",
    operationId: "listCustomers",
    summary: "List / search customers (cursor pagination)",
    tag: "customers",
    action: "customer:read",
    query: [
      { name: "search", type: "string", description: "Substring of id, name or email." },
      { name: "limit", type: "integer", description: "Page size (default 50, max 500)." },
      { name: "after", type: "string", description: "Cursor: the previous page's `next`." },
    ],
    resource: () => ({ type: "customer" }),
    response: { status: 200, schema: "CustomerPage", description: "A page of customers" },
    async handle(c) {
      const search = c.query.get("search") || undefined;
      const after = c.query.get("after") || undefined;
      const limit = intParam(c.query.get("limit"));
      return json(
        await c.engine.listCustomers({
          ...(search !== undefined ? { search } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    },
  },
  {
    method: "GET",
    path: "/api/customers/:id",
    operationId: "getCustomer",
    summary: "A customer's stored state and resolved entitlements with usage",
    tag: "customers",
    action: "customer:read",
    resource: customerRes,
    response: { status: 200, schema: "CustomerDetail", description: "Customer" },
    async handle(c) {
      const id = c.params.id!;
      const [state, entitlements] = await Promise.all([
        c.engine.getCustomer(id),
        c.engine.entitlements(id),
      ]);
      return json({ state, entitlements });
    },
  },
  {
    method: "PATCH",
    path: "/api/customers/:id",
    operationId: "updateCustomer",
    summary: "Update a customer's name, email or metadata (metadata is merged)",
    tag: "customers",
    action: "customer:update",
    resource: customerRes,
    body: "CustomerPatch",
    response: { status: 200, schema: "CustomerState", description: "Updated customer" },
    async handle(c) {
      const patch = await c.body(customerPatchSchema);
      return json(await c.engine.updateCustomer(c.params.id!, patch, { actor: c.actor }));
    },
  },
  {
    method: "DELETE",
    path: "/api/customers/:id",
    operationId: "deleteCustomer",
    summary: "Delete a customer's stored state",
    tag: "customers",
    action: "customer:delete",
    resource: customerRes,
    response: { status: 204, description: "Deleted" },
    async handle(c) {
      await c.engine.deleteCustomer(c.params.id!, { actor: c.actor });
      return noContent();
    },
  },

  // --- Admin: subscriptions ---------------------------------------------------
  {
    method: "POST",
    path: "/api/customers/:id/subscriptions",
    operationId: "subscribe",
    summary: "Subscribe to a plan or add-on (manual provider)",
    tag: "subscriptions",
    action: "subscription:write",
    resource: subRes,
    body: "SubscribeInput",
    response: { status: 201, schema: "Subscription", description: "Created subscription" },
    async handle(c) {
      const input = await c.body(subscribeSchema);
      return json(await c.engine.subscribe(c.params.id!, input, { actor: c.actor }), 201);
    },
  },
  {
    method: "PATCH",
    path: "/api/customers/:id/subscriptions/:sid",
    operationId: "updateSubscription",
    summary: "Update a subscription (status, quantity, version, period, …)",
    tag: "subscriptions",
    action: "subscription:write",
    resource: subRes,
    body: "SubscriptionPatch",
    response: { status: 200, schema: "Subscription", description: "Updated subscription" },
    async handle(c) {
      const id = c.params.id!;
      const sid = c.params.sid!;
      const patch = await c.body(subscriptionPatchSchema);
      const state = await c.engine.getCustomer(id);
      const existing = state?.subscriptions.find((s) => s.id === sid);
      if (!existing) throw new NotFoundError(`Subscription "${sid}" not found`);
      const { subscription } = await c.engine.upsertSubscription(
        id,
        { ...patch, id: sid, plan: patch.plan ?? existing.plan, provider: existing.provider },
        { actor: c.actor },
      );
      return json(subscription);
    },
  },
  {
    method: "POST",
    path: "/api/customers/:id/subscriptions/:sid/cancel",
    operationId: "cancelSubscription",
    summary: "Cancel a subscription now, or at the end of its period",
    tag: "subscriptions",
    action: "subscription:write",
    resource: subRes,
    body: "CancelInput",
    bodyRequired: false,
    response: { status: 200, schema: "Subscription", description: "Canceled subscription" },
    async handle(c) {
      const { atPeriodEnd } = await c.body(cancelSchema);
      return json(
        await c.engine.cancelSubscription(c.params.id!, c.params.sid!, {
          actor: c.actor,
          ...(atPeriodEnd !== undefined ? { atPeriodEnd } : {}),
        }),
      );
    },
  },
  {
    method: "DELETE",
    path: "/api/customers/:id/subscriptions/:sid",
    operationId: "removeSubscription",
    summary: "Remove a subscription entirely",
    tag: "subscriptions",
    action: "subscription:write",
    resource: subRes,
    response: { status: 204, description: "Removed" },
    async handle(c) {
      await c.engine.removeSubscription(c.params.id!, c.params.sid!, { actor: c.actor });
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/api/customers/:id/trials",
    operationId: "startTrial",
    summary: "Start a trial of a plan (one per plan unless forced)",
    tag: "subscriptions",
    action: "subscription:write",
    resource: subRes,
    body: "TrialInput",
    response: { status: 201, schema: "Subscription", description: "Trial subscription" },
    async handle(c) {
      const { plan, days, force } = await c.body(trialSchema);
      return json(
        await c.engine.startTrial(c.params.id!, plan, {
          actor: c.actor,
          ...(days !== undefined ? { days } : {}),
          ...(force !== undefined ? { force } : {}),
        }),
        201,
      );
    },
  },
  {
    method: "POST",
    path: "/api/plans/:plan/migrate",
    operationId: "migratePlan",
    summary: "Move subscriptions of a plan to another version (grandfathering exit)",
    tag: "subscriptions",
    action: "subscription:write",
    async resource(c) {
      const { customer } = await c.body(migrateSchema);
      return {
        type: "subscription",
        plan: c.params.plan!,
        ...(customer !== undefined && customer !== "*" ? { customer } : {}),
      };
    },
    body: "MigrateInput",
    bodyRequired: false,
    response: { status: 200, schema: "MigrateResult", description: "Migrated subscriptions" },
    async handle(c) {
      const { toVersion, customer } = await c.body(migrateSchema);
      return json(
        await c.engine.migratePlan(customer ?? "*", c.params.plan!, toVersion, {
          actor: c.actor,
        }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/customers/:id/reconcile",
    operationId: "reconcileCustomer",
    summary: "Pull the billing provider's state for a customer and converge on it",
    tag: "billing",
    action: "subscription:write",
    resource: subRes,
    body: "ReconcileInput",
    bodyRequired: false,
    response: {
      status: 200,
      schema: { type: "array", items: { $ref: "#/components/schemas/ReconcileResult" } },
      description: "One result per reconciled provider",
    },
    async handle(c) {
      const billing = requireBilling(c.ctx);
      const { provider } = await c.body(reconcileSchema);
      return json(await billing.reconcile(c.params.id!, provider));
    },
  },

  // --- Admin: grants + overrides ----------------------------------------------
  {
    method: "POST",
    path: "/api/customers/:id/grants",
    operationId: "createGrant",
    summary: "Grant a balance on a metered / credits / capacity feature",
    tag: "grants",
    action: "grant:write",
    resource: (c) => ({ type: "grant", customer: c.params.id! }),
    body: "GrantInput",
    response: { status: 201, schema: "Grant", description: "Created grant" },
    async handle(c) {
      const input = await c.body(grantSchema);
      return json(await c.engine.grant(c.params.id!, input, { actor: c.actor }), 201);
    },
  },
  {
    method: "DELETE",
    path: "/api/customers/:id/grants/:gid",
    operationId: "revokeGrant",
    summary: "Revoke a grant",
    tag: "grants",
    action: "grant:write",
    resource: (c) => ({ type: "grant", customer: c.params.id!, id: c.params.gid! }),
    response: { status: 204, description: "Revoked" },
    async handle(c) {
      await c.engine.revokeGrant(c.params.id!, c.params.gid!, { actor: c.actor });
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/api/customers/:id/overrides",
    operationId: "createOverride",
    summary: "Override one feature (comp, raise a limit, disable, set a value)",
    tag: "overrides",
    action: "override:write",
    resource: (c) => ({ type: "override", customer: c.params.id! }),
    body: "OverrideInput",
    response: { status: 201, schema: "Override", description: "Created override" },
    async handle(c) {
      const input = await c.body(overrideSchema);
      return json(await c.engine.override(c.params.id!, input, { actor: c.actor }), 201);
    },
  },
  {
    method: "DELETE",
    path: "/api/customers/:id/overrides/:oid",
    operationId: "removeOverride",
    summary: "Remove an override",
    tag: "overrides",
    action: "override:write",
    resource: (c) => ({ type: "override", customer: c.params.id!, id: c.params.oid! }),
    response: { status: 204, description: "Removed" },
    async handle(c) {
      await c.engine.removeOverride(c.params.id!, c.params.oid!, { actor: c.actor });
      return noContent();
    },
  },

  // --- Admin: usage -----------------------------------------------------------
  {
    method: "PUT",
    path: "/api/customers/:id/usage/:feature",
    operationId: "setUsage",
    summary: "Set the current usage of a feature (capacity: seats in use; metered: this period)",
    tag: "usage",
    action: "usage:write",
    resource: usageRes,
    body: "SetUsageInput",
    response: { status: 200, schema: "CheckResult", description: "The decision after the change" },
    async handle(c) {
      const { value } = await c.body(setUsageSchema);
      const id = c.params.id!;
      const feature = c.params.feature!;
      await c.engine.setUsage(id, feature, value, { actor: c.actor });
      return json(await c.engine.check(id, feature, { amount: 0 }));
    },
  },
  {
    method: "DELETE",
    path: "/api/customers/:id/usage/:feature",
    operationId: "resetUsage",
    summary: "Reset the current period's usage of a feature",
    tag: "usage",
    action: "usage:write",
    resource: usageRes,
    response: { status: 204, description: "Reset" },
    async handle(c) {
      await c.engine.resetUsage(c.params.id!, c.params.feature!, { actor: c.actor });
      return noContent();
    },
  },
  {
    method: "GET",
    path: "/api/customers/:id/usage/:feature/series",
    operationId: "usageSeries",
    summary: "Daily usage (UTC dates) for graphs",
    tag: "usage",
    action: "usage:read",
    query: [{ name: "days", type: "integer", description: "Days back, inclusive (default 30)." }],
    resource: usageRes,
    response: {
      status: 200,
      schema: { type: "array", items: { $ref: "#/components/schemas/UsagePoint" } },
      description: "One point per day",
    },
    async handle(c) {
      const days = intParam(c.query.get("days"));
      return json(
        await c.engine.usageSeries(
          c.params.id!,
          c.params.feature!,
          days !== undefined ? { days: Math.min(days, 400) } : {},
        ),
      );
    },
  },
  {
    method: "POST",
    path: "/api/reservations/sweep",
    operationId: "sweepReservations",
    summary: "Release expired reservations",
    tag: "usage",
    action: "usage:write",
    resource: () => ({ type: "usage" }),
    response: { status: 200, schema: "SweepResult", description: "Released reservations" },
    handle: async (c) => json(await c.engine.sweep()),
  },

  // --- Admin: activity --------------------------------------------------------
  {
    method: "GET",
    path: "/api/customers/:id/activity",
    operationId: "customerActivity",
    summary: "A customer's control-plane activity (newest first)",
    tag: "activity",
    action: "activity:read",
    query: [LIMIT],
    resource: (c) => ({ type: "activity", customer: c.params.id! }),
    response: {
      status: 200,
      schema: { type: "array", items: { $ref: "#/components/schemas/ActivityEntry" } },
      description: "Activity",
    },
    async handle(c) {
      const limit = intParam(c.query.get("limit"));
      return json(
        await c.engine.activity(c.params.id!, limit !== undefined ? { limit } : undefined),
      );
    },
  },
  {
    method: "GET",
    path: "/api/activity",
    operationId: "activity",
    summary: "Global control-plane activity (newest first)",
    tag: "activity",
    action: "activity:read",
    query: [LIMIT],
    resource: () => ({ type: "activity" }),
    response: {
      status: 200,
      schema: { type: "array", items: { $ref: "#/components/schemas/ActivityEntry" } },
      description: "Activity",
    },
    async handle(c) {
      const limit = intParam(c.query.get("limit"));
      return json(await c.engine.activity(undefined, limit !== undefined ? { limit } : undefined));
    },
  },

  // --- Runtime (server-to-server) --------------------------------------------
  {
    method: "POST",
    path: "/api/v1/check",
    operationId: "check",
    summary: "Check a feature (no usage recorded). Denials answer 200 with allowed: false",
    tag: "runtime",
    action: "runtime:check",
    async resource(c) {
      const { customer, feature } = await c.body(runtimeCheckSchema);
      return { type: "runtime", customer, feature };
    },
    body: "CheckInput",
    response: { status: 200, schema: "CheckResult", description: "The decision" },
    async handle(c) {
      const { customer, feature, amount } = await c.body(runtimeCheckSchema);
      return json(
        await c.engine.check(customer, feature, amount !== undefined ? { amount } : undefined),
      );
    },
  },
  {
    method: "POST",
    path: "/api/v1/consume",
    operationId: "consume",
    summary: "Atomically consume units; a refusal never counts",
    description:
      "Honors an `idempotency-key` header or a body `idempotencyKey` (the header wins). Denials answer 200 with `allowed: false`.",
    tag: "runtime",
    action: "runtime:consume",
    async resource(c) {
      const { customer, feature } = await c.body(runtimeConsumeSchema);
      return { type: "runtime", customer, feature };
    },
    body: "ConsumeInput",
    response: { status: 200, schema: "CheckResult", description: "The decision" },
    async handle(c) {
      const input = await c.body(runtimeConsumeSchema);
      const idempotencyKey = c.request.headers.get("idempotency-key") ?? input.idempotencyKey;
      return json(
        await c.engine.consume(
          input.customer,
          input.feature,
          input.amount,
          idempotencyKey !== undefined ? { idempotencyKey } : undefined,
        ),
      );
    },
  },
  {
    method: "POST",
    path: "/api/v1/release",
    operationId: "release",
    summary: "Give units back (a seat freed, a refund); clamped at 0",
    tag: "runtime",
    action: "runtime:consume",
    async resource(c) {
      const { customer, feature } = await c.body(runtimeReleaseSchema);
      return { type: "runtime", customer, feature };
    },
    body: "CheckInput",
    response: { status: 200, schema: "CheckResult", description: "The decision after release" },
    async handle(c) {
      const { customer, feature, amount } = await c.body(runtimeReleaseSchema);
      return json(await c.engine.release(customer, feature, amount));
    },
  },
  {
    method: "POST",
    path: "/api/v1/reserve",
    operationId: "reserve",
    summary: "Reserve units now, settle the actual amount later",
    tag: "runtime",
    action: "runtime:consume",
    async resource(c) {
      const { customer, feature } = await c.body(runtimeReserveSchema);
      return { type: "runtime", customer, feature };
    },
    body: "ReserveInput",
    response: { status: 200, schema: "ReserveResult", description: "The decision (+ reservation)" },
    async handle(c) {
      const { customer, feature, amount, ttl } = await c.body(runtimeReserveSchema);
      return json(
        await c.engine.reserve(customer, feature, amount, ttl !== undefined ? { ttl } : undefined),
      );
    },
  },
  {
    method: "POST",
    path: "/api/v1/settle",
    operationId: "settle",
    summary: "Settle a reservation with the actual amount (refund the rest / record the extra)",
    tag: "runtime",
    action: "runtime:consume",
    async resource(c) {
      const { reservationId } = await c.body(runtimeSettleSchema);
      const reservation = await c.engine.storage.getItem<Reservation>(
        reservationKey(reservationId),
      );
      return reservation
        ? { type: "runtime", customer: reservation.customer, feature: reservation.feature }
        : { type: "runtime" };
    },
    body: "SettleInput",
    response: { status: 200, schema: "CheckResult", description: "The decision after settling" },
    async handle(c) {
      const { reservationId, actual, overage } = await c.body(runtimeSettleSchema);
      return json(
        await c.engine.settle(
          reservationId,
          actual,
          overage !== undefined ? { overage } : undefined,
        ),
      );
    },
  },
  {
    method: "GET",
    path: "/api/v1/entitlements/:customer",
    operationId: "entitlements",
    summary: "A customer's full entitlement set with usage",
    tag: "runtime",
    action: "runtime:check",
    resource: (c) => ({ type: "runtime", customer: c.params.customer! }),
    response: { status: 200, schema: "CustomerEntitlements", description: "Entitlements" },
    handle: async (c) => json(await c.engine.entitlements(c.params.customer!)),
  },

  // --- Portal (portal token, or admin preview with ?customer=) ---------------
  {
    method: "GET",
    path: "/api/portal/me",
    operationId: "portalMe",
    summary: "The portal view: plan, usage vs limits, pricing, link-out availability",
    tag: "portal",
    action: "portal:read",
    query: [PREVIEW],
    resource: portalRes,
    response: { status: 200, schema: "PortalView", description: "Portal view" },
    async handle(c) {
      const id = c.portalCustomer!;
      const [state, entitlements] = await Promise.all([
        c.engine.getCustomer(id),
        c.engine.entitlements(id),
      ]);
      const allowed = (a: EntitlementsAction) => c.portalScope === null || c.portalScope.has(a);
      const view: PortalView = {
        ...entitlements,
        profile: profileOf(id, state),
        pricing: c.engine.pricing(),
        canCheckout: Boolean(c.ctx.billing?.canCheckout) && allowed("portal:checkout"),
        canManage: Boolean(c.ctx.billing?.canManage) && allowed("portal:manage"),
      };
      return json(view);
    },
  },
  {
    method: "POST",
    path: "/api/portal/checkout",
    operationId: "portalCheckout",
    summary: "Hosted checkout link-out for a plan or add-on",
    tag: "portal",
    action: "portal:checkout",
    query: [PREVIEW],
    resource: portalRes,
    body: "PortalCheckoutInput",
    response: { status: 200, schema: "LinkOut", description: "Provider checkout URL" },
    async handle(c) {
      const billing = requireBilling(c.ctx);
      const input = await c.body(portalCheckoutSchema);
      return json(await billing.createCheckout(c.portalCustomer!, input));
    },
  },
  {
    method: "POST",
    path: "/api/portal/manage",
    operationId: "portalManage",
    summary: "Hosted billing-portal link-out (payment methods, invoices, cancel)",
    tag: "portal",
    action: "portal:manage",
    query: [PREVIEW],
    resource: portalRes,
    body: "PortalManageInput",
    bodyRequired: false,
    response: { status: 200, schema: "LinkOut", description: "Provider billing-portal URL" },
    async handle(c) {
      const billing = requireBilling(c.ctx);
      const input = await c.body(portalManageSchema);
      return json(await billing.createPortalSession(c.portalCustomer!, input));
    },
  },
];

/** The documented route table (method, path, action, schemas) — every API route. */
export const API_ROUTES: readonly RouteSpec[] = ROUTES;

/** The paths served as the public bootstrap config (not in {@link API_ROUTES}). */
export const CONFIG_PATHS: readonly string[] = ["/config", "/api/config"];

function profileOf(id: string, state: CustomerState | null): PortalView["profile"] {
  return {
    id,
    ...(state?.name !== undefined ? { name: state.name } : {}),
    ...(state?.email !== undefined ? { email: state.email } : {}),
  };
}

interface Authenticated {
  principal: Principal | null;
  /** Set for portal-token principals. */
  portal: { customer: string; scope: ReadonlySet<EntitlementsAction> } | null;
}

/**
 * Authenticate a request. A portal token short-circuits the host's providers
 * entirely: valid → portal-scoped principal; invalid / expired → 401 (never
 * fall back to the host's auth with an explicitly presented, rejected
 * credential).
 */
async function authenticate(request: Request, ctx: ApiContext): Promise<Authenticated> {
  const bearer = request.headers.get("authorization");
  if (ctx.portal && bearer?.startsWith(`Bearer ${PORTAL_TOKEN_PREFIX}`)) {
    const claims = await verifyPortalToken(ctx.portal.secret, bearer.slice("Bearer ".length));
    return {
      principal: {
        id: `portal:${claims.customer}`,
        metadata: { portal: true, customer: claims.customer },
      },
      portal: { customer: claims.customer, scope: new Set(claims.scope) },
    };
  }
  // A throwing auth provider is a backend failure (IdP down, DB error) —
  // surfaced as 500, not a misleading 401. `null` means "no valid credentials".
  return { principal: await ctx.auth.authenticate(request), portal: null };
}

function panelConfig(ctx: ApiContext, who: Authenticated): PanelConfig {
  const { principal, portal } = who;
  return {
    title: ctx.title,
    ...(ctx.logoUrl !== undefined ? { logoUrl: ctx.logoUrl } : {}),
    basePath: ctx.basePath,
    readonly: ctx.readonly,
    mode: portal ? "portal" : "admin",
    authenticated: principal !== null,
    principal: principal
      ? {
          id: principal.id,
          ...(principal.name !== undefined ? { name: principal.name } : {}),
          ...(principal.email !== undefined ? { email: principal.email } : {}),
          ...(principal.roles !== undefined ? { roles: principal.roles } : {}),
        }
      : null,
    ...(portal ? { customer: portal.customer, scope: [...portal.scope] } : {}),
    billingProviders: [...(ctx.billing?.providers ?? [])],
  };
}

/**
 * Handle an API request. `path` is already base-path-stripped. Returns a
 * `Response` for API / config / intake routes, or `null` if the path is not
 * one (static assets and the SPA take it from there). `openapi` builds the
 * document served at `/api/openapi.json`.
 */
export async function handleApiRequest(
  request: Request,
  path: string,
  ctx: ApiContext,
  openapi: () => Record<string, unknown>,
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const isConfig = CONFIG_PATHS.includes(path);

  let route: ApiRoute | undefined;
  let params: Record<string, string> = {};
  const allowed = new Set<string>();
  if (!isConfig) {
    for (const r of ROUTES) {
      const m = match(r.path, path);
      if (!m) continue;
      allowed.add(r.method);
      if (!route && (r.method === method || (method === "HEAD" && r.method === "GET"))) {
        route = r;
        params = m;
      }
    }
    if (!route) {
      if (allowed.size > 0) {
        return methodNotAllowed(allowed);
      }
      return path.startsWith("/api/") ? error(404, "Not found") : null;
    }
  } else if (method !== "GET" && method !== "HEAD") {
    return methodNotAllowed(["GET"]);
  }

  try {
    if (route?.operationId === "getOpenApi") return json(openapi());

    const query = new URL(request.url).searchParams;
    let who: Authenticated = { principal: null, portal: null };
    if (isConfig || route?.action) who = await authenticate(request, ctx);
    if (isConfig) return json(panelConfig(ctx, who));
    route = route!;

    // Portal routes: resolve the customer the call is scoped to.
    let portalCustomer: string | undefined;
    if (route.tag === "portal") {
      portalCustomer = who.portal ? who.portal.customer : (query.get("customer") ?? undefined);
    }

    let raw: Promise<unknown> | undefined;
    const call: Call = {
      request,
      params,
      query,
      ctx,
      engine: ctx.engine,
      principal: who.principal,
      actor: who.principal ? actorFor(who.principal, who.portal?.customer) : null,
      portalScope: who.portal?.scope ?? null,
      ...(portalCustomer !== undefined ? { portalCustomer } : {}),
      async body(schema) {
        raw ??= request.text().then((text) => {
          if (text.trim() === "") return {};
          try {
            return JSON.parse(text) as unknown;
          } catch {
            throw new HttpError(400, "Invalid JSON body");
          }
        });
        return parseInput(schema, await raw);
      },
    };

    if (route.action) {
      if (who.principal === null) {
        return ctx.auth.challenge?.(request) ?? error(401, "Unauthorized");
      }
      if (route.tag === "portal" && portalCustomer === undefined) {
        throw new HttpError(400, "Missing ?customer= (admin preview of a portal)");
      }
      const resource = await route.resource!(call);
      if (who.portal) {
        // Defense in depth: the host's authorization provider is NOT consulted
        // for portal principals — the token is the whole grant, and it only
        // ever reaches its own customer's portal routes.
        if (route.tag !== "portal" || !who.portal.scope.has(route.action)) {
          return error(403, "Forbidden", { action: route.action });
        }
      } else {
        const ok = await ctx.authorization.authorize({
          principal: who.principal,
          action: route.action,
          resource,
          request,
        });
        if (!ok) return error(403, "Forbidden", { action: route.action });
      }
      if (ctx.readonly && isMutatingAction(route.action)) {
        throw new ReadonlyError(route.operationId);
      }
    }

    return await route.handle(call);
  } catch (err) {
    return mapError(err);
  }
}

/**
 * Cross-bundle error detection: `instanceof` first, `err.name` fallback. An
 * error thrown from a separate subpath bundle carries its own copy of the
 * class, so `instanceof` alone would mis-map it to 500.
 */
function isNamed(err: unknown, ctor: new (...args: never[]) => Error, name: string): boolean {
  return err instanceof ctor || (err instanceof Error && err.name === name);
}

/**
 * A hook denial, detected by `name` rather than `instanceof` (see
 * {@link isNamed}). Returns the status to respond with, or `null`.
 */
function hookDeniedStatus(err: unknown): number | null {
  if (err instanceof HookDeniedError) return err.status;
  if (err instanceof Error && err.name === "HookDeniedError") {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : 403;
  }
  return null;
}

/** Map domain errors to HTTP responses (docs/HTTP_API.md "Errors"). */
export function mapError(err: unknown): Response {
  if (err instanceof HttpError) return error(err.status, err.message, err.extra);
  if (isNamed(err, ReadonlyError, "ReadonlyError")) {
    return error(423, (err as Error).message, { code: "READONLY" });
  }
  const denied = hookDeniedStatus(err);
  if (denied !== null) return error(denied, (err as Error).message, { code: "HOOK_DENIED" });
  if (isNamed(err, PortalTokenError, "PortalTokenError")) {
    return error(401, (err as Error).message, { code: "PORTAL_TOKEN" });
  }
  if (isNamed(err, NotFoundError, "NotFoundError")) {
    return error(404, (err as Error).message, { code: "NOT_FOUND" });
  }
  if (isNamed(err, BillingVerificationError, "BillingVerificationError")) {
    return error(400, (err as Error).message, { code: "BILLING_VERIFICATION" });
  }
  if (isNamed(err, EntitlementsValidationError, "EntitlementsValidationError")) {
    const issues = (err as { issues?: unknown }).issues;
    return error(400, (err as Error).message, {
      code: "VALIDATION",
      ...(Array.isArray(issues) ? { issues } : {}),
    });
  }
  if (err instanceof SyntaxError) return error(400, "Invalid JSON body");
  const message = err instanceof Error ? err.message : "Internal error";
  return error(500, message);
}
