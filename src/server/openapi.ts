/**
 * OpenAPI 3.1 description of the panel's HTTP API.
 *
 * Exposed two ways, mirroring the flags / webhooks panels:
 *  - served at `GET {basePath}/api/openapi.json` for standalone tools (Scalar,
 *    Swagger UI, Postman, codegen) and services in other languages;
 *  - returned by `createFetchHandler(...).openapi()` so you can MERGE it into
 *    your host app's OpenAPI document (e.g. Elysia `@elysiajs/openapi`
 *    `references`, or Hono's OpenAPI).
 *
 * Paths are generated from the router's own table ({@link API_ROUTES}), so
 * every served route is documented; component schemas are hand-authored (no
 * generation dependency — flags precedent).
 *
 * @module
 */

import {
  buildOpenApiDocument as kitBuildOpenApiDocument,
  errorResponse,
  ref,
} from "@xtandard/kit/server/router";
import { isMutatingAction } from "../authorization/contract.ts";
import { API_ROUTES, CONFIG_PATHS, type RouteSpec } from "./routes.ts";

/** Options for {@link buildOpenApiDocument}. */
export interface OpenApiOptions {
  /** Mount prefix used in the `servers` url (e.g. `"/billing"`). */
  basePath?: string;
  /** Document title. */
  title?: string;
  /** Document version. Default `"1"` (the HTTP API version, not the package version). */
  version?: string;
}

type Schema = Record<string, unknown>;

const arrayOf = (name: string): Schema => ({ type: "array", items: ref(name) });
const str: Schema = { type: "string" };
const num: Schema = { type: "number" };
const int: Schema = { type: "integer" };
const bool: Schema = { type: "boolean" };
const time: Schema = { type: "string", format: "date-time" };
const nullableNum: Schema = { type: ["number", "null"] };
const nullableTime: Schema = { type: ["string", "null"], format: "date-time" };
const json: Schema = { description: "Any JSON value." };
const jsonObject: Schema = { type: "object", additionalProperties: true };
const obj = (properties: Schema, required: string[] = [], extra: Schema = {}): Schema => ({
  type: "object",
  ...(required.length ? { required } : {}),
  properties,
  ...extra,
});

const STATUSES = ["active", "trialing", "past_due", "paused", "canceled", "incomplete"];
const KINDS = ["boolean", "metered", "capacity", "value", "credits"];
const RESETS = ["day", "week", "month", "quarter", "year", "billing_period", "never"];
const REASONS = [
  "included",
  "within_limit",
  "overage_allowed",
  "limit_reached",
  "not_in_plan",
  "disabled_by_override",
  "granted_by_override",
  "subscription_inactive",
  "unknown_feature",
  "fallback",
];

const actor = obj({ id: str, name: str, email: str, type: str }, ["id"]);

const schemas: Record<string, Schema> = {
  Error: obj(
    {
      error: str,
      code: {
        type: "string",
        enum: [
          "VALIDATION",
          "NOT_FOUND",
          "READONLY",
          "HOOK_DENIED",
          "PORTAL_TOKEN",
          "BILLING_VERIFICATION",
        ],
      },
      issues: {
        type: "array",
        items: obj({ path: str, message: str }, ["path", "message"]),
        description: "Schema validation issues (400).",
      },
      action: { type: "string", description: "The denied action (403)." },
    },
    ["error"],
  ),
  Health: obj({ ok: { const: true } }, ["ok"]),
  PanelConfig: obj(
    {
      title: str,
      logoUrl: str,
      basePath: str,
      readonly: bool,
      mode: { type: "string", enum: ["admin", "portal"] },
      authenticated: bool,
      principal: {
        type: ["object", "null"],
        properties: { id: str, name: str, email: str, roles: { type: "array", items: str } },
      },
      customer: { type: "string", description: "Portal mode: the token's customer." },
      scope: { type: "array", items: str, description: "Portal mode: granted portal actions." },
      billingProviders: { type: "array", items: str },
    },
    ["title", "basePath", "readonly", "mode", "authenticated", "principal", "billingProviders"],
  ),
  Actor: actor,
  Subscription: obj(
    {
      id: str,
      plan: { type: "string", description: "Plan key, or add-on key when kind is addon." },
      version: int,
      kind: { type: "string", enum: ["plan", "addon"] },
      status: { type: "string", enum: STATUSES },
      quantity: num,
      periodStart: time,
      periodEnd: time,
      trialEndsAt: time,
      cancelAtPeriodEnd: bool,
      canceledAt: time,
      provider: str,
      providerRef: str,
      providerUpdatedAt: time,
      createdAt: time,
      updatedAt: time,
      metadata: jsonObject,
    },
    ["id", "plan", "version", "kind", "status", "quantity", "provider", "createdAt", "updatedAt"],
  ),
  Grant: obj(
    {
      id: str,
      feature: str,
      amount: num,
      recurring: bool,
      priority: num,
      startsAt: time,
      expiresAt: time,
      reason: str,
      actor: ref("Actor"),
      createdAt: time,
      metadata: jsonObject,
    },
    ["id", "feature", "amount", "priority", "createdAt"],
  ),
  Override: obj(
    {
      id: str,
      feature: str,
      enabled: bool,
      limit: nullableNum,
      overage: { type: "string", enum: ["block", "allow"] },
      value: json,
      startsAt: time,
      expiresAt: time,
      reason: str,
      actor: ref("Actor"),
      createdAt: time,
    },
    ["id", "feature", "createdAt"],
  ),
  CustomerState: obj(
    {
      id: str,
      name: str,
      email: str,
      subscriptions: arrayOf("Subscription"),
      grants: arrayOf("Grant"),
      overrides: arrayOf("Override"),
      providers: { type: "object", additionalProperties: str },
      trials: { type: "object", additionalProperties: time },
      metadata: jsonObject,
      createdAt: time,
      updatedAt: time,
      revision: int,
    },
    [
      "id",
      "subscriptions",
      "grants",
      "overrides",
      "providers",
      "trials",
      "metadata",
      "createdAt",
      "updatedAt",
      "revision",
    ],
  ),
  CustomerSummary: obj(
    {
      id: str,
      name: str,
      email: str,
      plans: { type: "array", items: str },
      statuses: { type: "array", items: { type: "string", enum: STATUSES } },
      updatedAt: time,
    },
    ["id", "plans", "statuses", "updatedAt"],
  ),
  CustomerPage: obj(
    {
      customers: arrayOf("CustomerSummary"),
      next: { type: "string", description: "Cursor for the next page (pass as `after`)." },
    },
    ["customers"],
  ),
  FeatureUsage: obj(
    {
      key: str,
      kind: { type: "string", enum: KINDS },
      enabled: bool,
      allowance: nullableNum,
      limit: nullableNum,
      overagePolicy: { type: "string", enum: ["block", "allow"] },
      overageLimit: nullableNum,
      reset: { type: "string", enum: RESETS },
      period: obj({ key: str, start: nullableTime, end: nullableTime }),
      value: json,
      sources: { type: "array", items: jsonObject },
      override: str,
      used: num,
      remaining: nullableNum,
      overage: num,
      resetsAt: nullableTime,
      grantBalances: {
        type: "array",
        items: obj({ id: str, amount: num, used: num, expiresAt: time }, ["id", "amount", "used"]),
      },
    },
    ["key", "kind", "enabled", "sources"],
  ),
  CustomerEntitlements: obj(
    {
      customer: str,
      plans: {
        type: "array",
        items: obj(
          {
            plan: str,
            version: int,
            group: str,
            default: bool,
            status: { type: "string", enum: STATUSES },
            subscriptionId: str,
            trialEndsAt: time,
            periodEnd: time,
            cancelAtPeriodEnd: bool,
          },
          ["plan", "version", "group", "default"],
        ),
      },
      addons: {
        type: "array",
        items: obj({ addon: str, quantity: num, subscriptionId: str, applied: bool }),
      },
      features: { type: "object", additionalProperties: ref("FeatureUsage") },
      inactive: {
        type: "array",
        items: obj({ subscriptionId: str, plan: str, reason: str }),
      },
      validUntil: nullableTime,
      resolvedAt: time,
      stale: bool,
    },
    ["customer", "plans", "addons", "features", "inactive", "validUntil", "resolvedAt"],
  ),
  CustomerDetail: obj(
    {
      state: { oneOf: [ref("CustomerState"), { type: "null" }] },
      entitlements: ref("CustomerEntitlements"),
    },
    ["state", "entitlements"],
  ),
  CheckResult: obj(
    {
      allowed: bool,
      feature: str,
      kind: { type: "string", enum: [...KINDS, "unknown"] },
      reason: { type: "string", enum: REASONS },
      denial: {
        type: "string",
        enum: ["payment_required", "forbidden"],
        description:
          "payment_required = an upgrade would allow it (402); forbidden = no plan would (403).",
      },
      limit: nullableNum,
      used: num,
      remaining: nullableNum,
      overage: num,
      resetsAt: nullableTime,
      value: json,
      unlockedBy: {
        type: "array",
        items: str,
        description: "Plans / add-ons that would allow the request, cheapest first.",
      },
      stale: bool,
      buffered: bool,
      duplicate: bool,
      requested: num,
    },
    ["allowed", "feature", "kind", "reason", "unlockedBy"],
  ),
  Reservation: obj(
    {
      id: str,
      customer: str,
      feature: str,
      amount: num,
      takes: { type: "array", items: obj({ key: str, amount: num, feature: str }) },
      rates: { type: "object", additionalProperties: num },
      metadata: jsonObject,
      createdAt: time,
      expiresAt: time,
    },
    ["id", "customer", "feature", "amount", "takes", "rates", "createdAt", "expiresAt"],
  ),
  ReserveResult: {
    allOf: [ref("CheckResult"), obj({ reservation: ref("Reservation") })],
  },
  ActivityEntry: obj(
    {
      id: str,
      customer: str,
      type: str,
      at: time,
      actor: ref("Actor"),
      summary: str,
      data: jsonObject,
    },
    ["id", "customer", "type", "at", "summary"],
  ),
  UsagePoint: obj({ date: { type: "string", format: "date" }, value: num }, ["date", "value"]),
  PricingTable: obj(
    {
      features: {
        type: "array",
        items: obj(
          {
            key: str,
            name: str,
            kind: { type: "string", enum: KINDS },
            description: str,
            unit: str,
            units: str,
          },
          ["key", "name", "kind"],
        ),
      },
      plans: { type: "array", items: jsonObject },
      addons: { type: "array", items: jsonObject },
    },
    ["features", "plans", "addons"],
    {
      description: "Display-ready catalog (see `PricingTable` in @xtandard/entitlements/catalog).",
    },
  ),
  CatalogView: obj(
    {
      features: { type: "array", items: jsonObject, description: "NormalizedFeature[]" },
      plans: {
        type: "array",
        items: jsonObject,
        description: "NormalizedPlan[] — every version, current first per plan.",
      },
      addons: { type: "array", items: jsonObject, description: "NormalizedAddon[]" },
      pricing: ref("PricingTable"),
    },
    ["features", "plans", "addons", "pricing"],
  ),
  Overview: obj(
    {
      customers: int,
      byPlan: { type: "object", additionalProperties: int },
      statuses: { type: "object", additionalProperties: int },
      trialsEndingSoon: {
        type: "array",
        items: obj({ customer: str, plan: str, trialEndsAt: time }, [
          "customer",
          "plan",
          "trialEndsAt",
        ]),
      },
      recentActivity: arrayOf("ActivityEntry"),
    },
    ["customers", "byPlan", "statuses", "trialsEndingSoon", "recentActivity"],
  ),
  PortalView: {
    allOf: [
      ref("CustomerEntitlements"),
      obj(
        {
          profile: obj({ id: str, name: str, email: str }, ["id"]),
          pricing: ref("PricingTable"),
          canCheckout: bool,
          canManage: bool,
        },
        ["profile", "pricing", "canCheckout", "canManage"],
      ),
    ],
  },
  LinkOut: obj({ url: { type: "string", format: "uri" } }, ["url"]),
  WebhookReceipt: obj(
    {
      received: { const: true },
      outcome: { type: "string", enum: ["applied", "duplicate", "ignored", "stale"] },
    },
    ["received", "outcome"],
  ),
  ReconcileResult: obj({ customer: str, provider: str, upserted: int, canceled: int }, [
    "customer",
    "provider",
    "upserted",
    "canceled",
  ]),
  MigrateResult: obj({ migrated: int }, ["migrated"]),
  SweepResult: obj({ released: int }, ["released"]),

  // --- request bodies ---
  CustomerPatch: obj({ name: str, email: str, metadata: jsonObject }, [], {
    additionalProperties: false,
  }),
  SubscribeInput: obj(
    {
      plan: str,
      version: { type: "integer", minimum: 1 },
      quantity: { type: "number", minimum: 0 },
      status: { type: "string", enum: STATUSES },
      trialEndsAt: time,
      metadata: jsonObject,
      replace: {
        type: "boolean",
        description:
          "Cancel the customer's other manual subscriptions in the same group (default true).",
      },
    },
    ["plan"],
    { additionalProperties: false },
  ),
  SubscriptionPatch: obj(
    {
      plan: str,
      version: { type: "integer", minimum: 1 },
      kind: { type: "string", enum: ["plan", "addon"] },
      status: { type: "string", enum: STATUSES },
      quantity: { type: "number", minimum: 0 },
      periodStart: time,
      periodEnd: time,
      trialEndsAt: time,
      cancelAtPeriodEnd: bool,
      canceledAt: time,
      provider: str,
      providerRef: str,
      providerUpdatedAt: time,
      metadata: jsonObject,
    },
    [],
    { additionalProperties: false },
  ),
  CancelInput: obj({ atPeriodEnd: bool }, [], { additionalProperties: false }),
  TrialInput: obj({ plan: str, days: { type: "integer", minimum: 1 }, force: bool }, ["plan"], {
    additionalProperties: false,
  }),
  GrantInput: obj(
    {
      feature: str,
      amount: { type: "number", exclusiveMinimum: 0 },
      recurring: bool,
      priority: num,
      startsAt: time,
      expiresAt: time,
      reason: str,
      metadata: jsonObject,
    },
    ["feature", "amount"],
    { additionalProperties: false },
  ),
  OverrideInput: obj(
    {
      feature: str,
      enabled: bool,
      limit: { type: ["number", "null"], minimum: 0 },
      overage: { type: "string", enum: ["block", "allow"] },
      value: json,
      startsAt: time,
      expiresAt: time,
      reason: str,
    },
    ["feature"],
    { additionalProperties: false },
  ),
  SetUsageInput: obj({ value: { type: "number", minimum: 0 } }, ["value"], {
    additionalProperties: false,
  }),
  MigrateInput: obj(
    {
      toVersion: { type: "integer", minimum: 1 },
      customer: { type: "string", description: 'One customer, or "*" (default) for all.' },
    },
    [],
    { additionalProperties: false },
  ),
  ReconcileInput: obj({ provider: str }, [], { additionalProperties: false }),
  CheckInput: obj(
    { customer: str, feature: str, amount: { type: "number", minimum: 0 } },
    ["customer", "feature"],
    { additionalProperties: false },
  ),
  ConsumeInput: obj(
    {
      customer: str,
      feature: str,
      amount: { type: "number", minimum: 0 },
      idempotencyKey: str,
    },
    ["customer", "feature"],
    { additionalProperties: false },
  ),
  ReserveInput: obj(
    {
      customer: str,
      feature: str,
      amount: { type: "number", minimum: 0 },
      ttl: {
        oneOf: [num, { type: "string", pattern: "^\\d+(\\.\\d+)?(ms|s|m|h|d|w)$" }],
        description: 'Milliseconds or a duration like "5m".',
      },
    },
    ["customer", "feature", "amount"],
    { additionalProperties: false },
  ),
  SettleInput: obj(
    {
      reservationId: str,
      actual: { type: "number", minimum: 0 },
      overage: { type: "string", enum: ["record", "cap"] },
    },
    ["reservationId", "actual"],
    { additionalProperties: false },
  ),
  PortalCheckoutInput: obj(
    {
      plan: { type: "string", description: "Plan or add-on key." },
      quantity: { type: "integer", minimum: 1 },
      successUrl: str,
      cancelUrl: str,
    },
    ["plan"],
    { additionalProperties: false },
  ),
  PortalManageInput: obj({ returnUrl: str }, [], { additionalProperties: false }),
};

const errorRes = errorResponse;

/**
 * The entitlements-specific parts of each operation, over the kit's generated
 * one: auth error wording, billing / portal 404s, the 423 readonly status and
 * the `consume` idempotency header.
 */
function operation(spec: RouteSpec, generated: Schema): Schema {
  const responses = generated.responses as Record<string, Schema>;
  if (spec.action) {
    responses["401"] = errorRes("Unauthenticated, or a bad / expired portal token");
    responses["403"] = errorRes("Denied by authorization, portal scope or a hook");
  }
  if (spec.tag === "billing") {
    responses["400"] = errorRes("Bad signature / payload or invalid input");
    responses["404"] = errorRes("Billing not configured, or unknown provider");
  }
  if (spec.tag === "portal" && spec.method === "POST") {
    responses["404"] = errorRes("Billing not configured");
  }
  const parameters = (generated.parameters as Schema[] | undefined) ?? [];
  if (spec.operationId === "consume") {
    parameters.push({ name: "idempotency-key", in: "header", required: false, schema: str });
  }
  return { ...generated, ...(parameters.length ? { parameters } : {}), responses };
}

/** The bootstrap config operation (served at both {@link CONFIG_PATHS}). */
const configOperation = (operationId: string): Schema => ({
  operationId,
  tags: ["panel"],
  summary: "SPA bootstrap config: mode (admin / portal), principal, billing providers",
  security: [],
  responses: {
    "200": {
      description: "Panel config",
      content: { "application/json": { schema: ref("PanelConfig") } },
    },
    "401": errorRes("A bad / expired portal token was presented"),
  },
});

/**
 * Build the OpenAPI 3.1 document for the panel API. Every route of
 * docs/HTTP_API.md is present; admin routes carry their authorization action
 * as `x-action`.
 *
 * @example
 * ```ts
 * import { buildOpenApiDocument } from "@xtandard/entitlements";
 * const doc = buildOpenApiDocument({ basePath: "/billing", title: "Acme billing" });
 * ```
 */
export function buildOpenApiDocument(options: OpenApiOptions = {}): Record<string, unknown> {
  const doc = kitBuildOpenApiDocument({
    routes: API_ROUTES,
    title: options.title ?? "@xtandard/entitlements",
    version: options.version ?? "1",
    description:
      "Entitlements, plans and usage metering: admin API, runtime API (server-to-server), customer portal API and billing webhook intake. Denials are not errors — runtime routes answer 200 with a CheckResult whose `allowed` is false.",
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
    tags: [
      { name: "panel", description: "Bootstrap, health, this document" },
      { name: "catalog", description: "Features, plans, add-ons, pricing" },
      { name: "customers", description: "Customer state and overview" },
      { name: "subscriptions", description: "Plans, add-ons, trials, migrations" },
      { name: "grants", description: "Balances on numeric features" },
      { name: "overrides", description: "Per-customer feature exceptions" },
      { name: "usage", description: "Usage corrections, series, reservations" },
      { name: "activity", description: "Control-plane activity" },
      { name: "runtime", description: "check / consume / reserve / settle for other services" },
      { name: "portal", description: "Customer portal (portal token or admin preview)" },
      { name: "billing", description: "Provider webhook intake and reconcile" },
    ],
    schemas,
    bearerDescription: "Portal tokens (entpt_…) or host-issued bearer credentials.",
    isMutatingAction,
    readonlyStatus: 423,
    operation,
  });
  const paths: Record<string, unknown> = {};
  for (const path of CONFIG_PATHS) {
    paths[path] = {
      get: configOperation(path === "/config" ? "getConfig" : "getApiConfig"),
    };
  }
  return { ...doc, paths: { ...paths, ...(doc.paths as Record<string, unknown>) } };
}
