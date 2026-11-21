/**
 * Elysia 1.x adapter. Three pieces:
 *
 * 1. {@link entitlementsPanel} — a web-standard handler for
 *    `Elysia.mount(path, handler)`. Simplest, but opaque to Eden.
 *
 *    ```ts
 *    new Elysia().mount("/billing", entitlementsPanel({ catalog, basePath: "/billing" }));
 *    ```
 *
 * 2. {@link entitlementsElysia} — a typed Elysia plugin that _declares_ every
 *    route, so **Eden treaty** infers them:
 *    `client.billing.api.v1.consume.post({ customer, feature })`. Each handler
 *    delegates to the same pipeline (auth, validation, portal scoping reused).
 *
 *    ```ts
 *    import { treaty } from "@elysiajs/eden";
 *    const app = new Elysia().use(entitlementsElysia({ prefix: "/billing", catalog }));
 *    const client = treaty<typeof app>("localhost:3000");
 *    await client.billing.api.v1.check.post({ customer: "org_1", feature: "export_pdf" });
 *    ```
 *
 * 3. {@link requireEntitlement} — a `beforeHandle` guard answering `402` /
 *    `403` JSON for denials and setting `ctx.entitlement`.
 *
 * Elysia 1.x only — for Elysia 2 import from `@xtandard/entitlements/elysia2`.
 *
 * @module
 */

import { Elysia, t } from "elysia";
import type { AnyCatalog } from "../catalog.ts";
import {
  createPass,
  entitlementsPanel,
  requireEntitlement,
  type ElysiaEntitlementsHandler,
  type ElysiaGuardContext,
  type EntitlementsElysiaOptions,
  type EntitlementsPanelOptions,
  type RequireEntitlementOptions,
} from "./elysia-shared.ts";

export { entitlementsPanel, requireEntitlement };
export type {
  ElysiaEntitlementsHandler,
  ElysiaGuardContext,
  EntitlementsElysiaOptions,
  EntitlementsPanelOptions,
  RequireEntitlementOptions,
};

const status = t.Union([
  t.Literal("active"),
  t.Literal("trialing"),
  t.Literal("past_due"),
  t.Literal("paused"),
  t.Literal("canceled"),
  t.Literal("incomplete"),
]);
const jsonObject = t.Record(t.String(), t.Any());

const P = {
  id: t.Object({ id: t.String() }),
  sub: t.Object({ id: t.String(), sid: t.String() }),
  grant: t.Object({ id: t.String(), gid: t.String() }),
  override: t.Object({ id: t.String(), oid: t.String() }),
  usage: t.Object({ id: t.String(), feature: t.String() }),
  plan: t.Object({ plan: t.String() }),
  customer: t.Object({ customer: t.String() }),
  provider: t.Object({ provider: t.String() }),
};

const B = {
  customer: t.Object({
    name: t.Optional(t.String()),
    email: t.Optional(t.String()),
    metadata: t.Optional(jsonObject),
  }),
  subscribe: t.Object({
    plan: t.String(),
    version: t.Optional(t.Number()),
    quantity: t.Optional(t.Number()),
    status: t.Optional(status),
    trialEndsAt: t.Optional(t.String()),
    metadata: t.Optional(jsonObject),
    replace: t.Optional(t.Boolean()),
  }),
  subscription: t.Object({
    plan: t.Optional(t.String()),
    version: t.Optional(t.Number()),
    kind: t.Optional(t.Union([t.Literal("plan"), t.Literal("addon")])),
    status: t.Optional(status),
    quantity: t.Optional(t.Number()),
    periodStart: t.Optional(t.String()),
    periodEnd: t.Optional(t.String()),
    trialEndsAt: t.Optional(t.String()),
    cancelAtPeriodEnd: t.Optional(t.Boolean()),
    canceledAt: t.Optional(t.String()),
    provider: t.Optional(t.String()),
    providerRef: t.Optional(t.String()),
    providerUpdatedAt: t.Optional(t.String()),
    metadata: t.Optional(jsonObject),
  }),
  cancel: t.Optional(t.Object({ atPeriodEnd: t.Optional(t.Boolean()) })),
  trial: t.Object({
    plan: t.String(),
    days: t.Optional(t.Number()),
    force: t.Optional(t.Boolean()),
  }),
  grant: t.Object({
    feature: t.String(),
    amount: t.Number(),
    recurring: t.Optional(t.Boolean()),
    priority: t.Optional(t.Number()),
    startsAt: t.Optional(t.String()),
    expiresAt: t.Optional(t.String()),
    reason: t.Optional(t.String()),
    metadata: t.Optional(jsonObject),
  }),
  override: t.Object({
    feature: t.String(),
    enabled: t.Optional(t.Boolean()),
    limit: t.Optional(t.Nullable(t.Number())),
    overage: t.Optional(t.Union([t.Literal("block"), t.Literal("allow")])),
    value: t.Optional(t.Any()),
    startsAt: t.Optional(t.String()),
    expiresAt: t.Optional(t.String()),
    reason: t.Optional(t.String()),
  }),
  usage: t.Object({ value: t.Number() }),
  migrate: t.Optional(
    t.Object({ toVersion: t.Optional(t.Number()), customer: t.Optional(t.String()) }),
  ),
  reconcile: t.Optional(t.Object({ provider: t.Optional(t.String()) })),
  check: t.Object({ customer: t.String(), feature: t.String(), amount: t.Optional(t.Number()) }),
  consume: t.Object({
    customer: t.String(),
    feature: t.String(),
    amount: t.Optional(t.Number()),
    idempotencyKey: t.Optional(t.String()),
  }),
  reserve: t.Object({
    customer: t.String(),
    feature: t.String(),
    amount: t.Number(),
    ttl: t.Optional(t.Union([t.Number(), t.String()])),
  }),
  settle: t.Object({
    reservationId: t.String(),
    actual: t.Number(),
    overage: t.Optional(t.Union([t.Literal("record"), t.Literal("cap")])),
  }),
  checkout: t.Object({
    plan: t.String(),
    quantity: t.Optional(t.Number()),
    successUrl: t.Optional(t.String()),
    cancelUrl: t.Optional(t.String()),
  }),
  manage: t.Optional(t.Object({ returnUrl: t.Optional(t.String()) })),
};

const preview = t.Object({ customer: t.Optional(t.String()) });

/**
 * The typed plugin {@link entitlementsElysia} returns: an `Elysia` instance
 * whose route table (every route with its params and body schema) is what Eden
 * treaty infers from `typeof app`.
 */
export type EntitlementsElysiaPlugin = ReturnType<typeof entitlementsElysiaRoutes>;

/**
 * Typed Elysia plugin exposing the whole HTTP API so the **Eden** client can
 * call it with full path / method / param / body typing. Every handler
 * delegates to the shared fetch pipeline; a catch-all serves the bundled UI.
 * The engine is decorated onto the context as `entitlements`, so the host's
 * own handlers can meter in-process: `({ entitlements }) => entitlements.consume(…)`.
 *
 * Elysia 1.x only — for Elysia 2 import from `@xtandard/entitlements/elysia2`.
 */
export function entitlementsElysia<const C extends AnyCatalog = AnyCatalog>(
  options: EntitlementsElysiaOptions<C>,
): EntitlementsElysiaPlugin {
  return entitlementsElysiaRoutes(options as EntitlementsElysiaOptions);
}

/**
 * The route declarations behind {@link entitlementsElysia}; its inferred type
 * is {@link EntitlementsElysiaPlugin}.
 *
 * @internal
 */
function entitlementsElysiaRoutes(options: EntitlementsElysiaOptions) {
  const { prefix, handler, pass, raw } = createPass(options);
  const customer = "/api/customers/:id";
  const subscription = `${customer}/subscriptions/:sid`;

  return new Elysia({ prefix, name: "xtandard-entitlements" })
    .decorate("entitlements", handler.engine)
    .get("/config", pass)
    .get("/api/config", pass)
    .get("/healthcheck", pass)
    .get("/api/openapi.json", pass)
    .get("/api/pricing", pass)
    .post("/webhooks/:provider", raw, { params: P.provider, parse: "none" })
    .get("/api/catalog", pass)
    .get("/api/overview", pass)
    .get("/api/customers", pass)
    .get(customer, pass, { params: P.id })
    .patch(customer, pass, { params: P.id, body: B.customer })
    .delete(customer, pass, { params: P.id })
    .post(`${customer}/subscriptions`, pass, { params: P.id, body: B.subscribe })
    .patch(subscription, pass, { params: P.sub, body: B.subscription })
    .post(`${subscription}/cancel`, pass, { params: P.sub, body: B.cancel })
    .delete(subscription, pass, { params: P.sub })
    .post(`${customer}/trials`, pass, { params: P.id, body: B.trial })
    .post(`${customer}/grants`, pass, { params: P.id, body: B.grant })
    .delete(`${customer}/grants/:gid`, pass, { params: P.grant })
    .post(`${customer}/overrides`, pass, { params: P.id, body: B.override })
    .delete(`${customer}/overrides/:oid`, pass, { params: P.override })
    .put(`${customer}/usage/:feature`, pass, { params: P.usage, body: B.usage })
    .delete(`${customer}/usage/:feature`, pass, { params: P.usage })
    .get(`${customer}/usage/:feature/series`, pass, { params: P.usage })
    .get(`${customer}/activity`, pass, { params: P.id })
    .post(`${customer}/reconcile`, pass, { params: P.id, body: B.reconcile })
    .get("/api/activity", pass)
    .post("/api/plans/:plan/migrate", pass, { params: P.plan, body: B.migrate })
    .post("/api/reservations/sweep", pass)
    .post("/api/v1/check", pass, { body: B.check })
    .post("/api/v1/consume", pass, { body: B.consume })
    .post("/api/v1/release", pass, { body: B.check })
    .post("/api/v1/reserve", pass, { body: B.reserve })
    .post("/api/v1/settle", pass, { body: B.settle })
    .get("/api/v1/entitlements/:customer", pass, { params: P.customer })
    .get("/api/portal/me", pass, { query: preview })
    .post("/api/portal/checkout", pass, { query: preview, body: B.checkout })
    .post("/api/portal/manage", pass, { query: preview, body: B.manage })
    .all("/*", pass); // bundled UI assets + SPA fallback
}
