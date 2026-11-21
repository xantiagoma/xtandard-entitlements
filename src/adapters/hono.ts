/**
 * Hono adapter. {@link entitlementsPanel} returns a `Hono` sub-app whose
 * catch-all delegates to the web-standard panel handler (compose with
 * `app.route(path, panel)`); {@link requireEntitlement} is a middleware that
 * answers `402` / `403` JSON for denials and sets `c.var.entitlement` for the
 * allowed decision.
 *
 * ```ts
 * import { entitlementsPanel, requireEntitlement } from "@xtandard/entitlements/hono";
 *
 * const panel = entitlementsPanel({ catalog, basePath: "/billing" });
 * app.route("/billing", panel);
 * app.post(
 *   "/api/export",
 *   requireEntitlement(panel.engine, "export_pdf", { customer: (c) => c.req.header("x-org-id") }),
 *   (c) => c.json({ remaining: c.var.entitlement.remaining }),
 * );
 * ```
 *
 * @module
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AnyCatalog, FeatureKey } from "../catalog.ts";
import type { Entitlements } from "../engine.ts";
import type { CheckResult } from "../schema.ts";
import {
  createFetchHandler,
  type CreateFetchHandlerResult,
  type EntitlementsPanelOptions,
} from "../server/create-fetch-handler.ts";
import { evaluateGuard, outcomeResponse, type RequireEntitlementOptions } from "./guard.ts";

/** The Hono sub-app {@link entitlementsPanel} returns, with the engine attached. */
export type HonoEntitlementsPanel<C extends AnyCatalog = AnyCatalog> = Hono & {
  engine: Entitlements<C>;
  openapi: CreateFetchHandlerResult<C>["openapi"];
  close: CreateFetchHandlerResult<C>["close"];
};

/** Create a Hono sub-app serving the panel. */
export function entitlementsPanel<const C extends AnyCatalog = AnyCatalog>(
  options: EntitlementsPanelOptions<C>,
): HonoEntitlementsPanel<C> {
  const handler = createFetchHandler(options);
  const app = new Hono();
  app.all("*", (c) => handler.fetch(c.req.raw));
  return Object.assign(app, {
    engine: handler.engine,
    openapi: handler.openapi,
    close: handler.close,
  });
}

/** Context variables set by {@link requireEntitlement}. */
export interface EntitlementVariables {
  /** The allowing decision for the guarded feature. */
  entitlement: CheckResult;
}

/**
 * Hono middleware guarding a route with an entitlement (ADR 0009). The
 * `customer` resolver receives the Hono `Context`.
 */
export function requireEntitlement<C extends AnyCatalog>(
  engine: Entitlements<C>,
  feature: FeatureKey<C>,
  options: RequireEntitlementOptions<Context>,
): MiddlewareHandler<{ Variables: EntitlementVariables }> {
  return async (c, next) => {
    const outcome = await evaluateGuard(engine, feature, options, c as unknown as Context);
    if (!outcome.allowed) return outcomeResponse(outcome, options, c as unknown as Context);
    c.set("entitlement", outcome.result);
    await next();
  };
}

export type { EntitlementsPanelOptions, RequireEntitlementOptions };
