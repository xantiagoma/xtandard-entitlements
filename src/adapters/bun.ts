/**
 * Bun adapter. The handler is already web-standard, so the panel is a
 * passthrough you can hand straight to `Bun.serve({ fetch })`; the guard wraps
 * a route handler.
 *
 * ```ts
 * import { entitlementsPanel, requireEntitlement } from "@xtandard/entitlements/bun";
 *
 * const panel = entitlementsPanel({ catalog, basePath: "/billing" });
 * const exportPdf = requireEntitlement(panel.engine, "export_pdf", {
 *   customer: (req) => req.headers.get("x-org-id"),
 * });
 *
 * Bun.serve({
 *   port: 3000,
 *   routes: {
 *     "/billing/*": panel.fetch,
 *     "/api/export": exportPdf(async (req, decision) => Response.json({ ok: true, decision })),
 *   },
 * });
 * ```
 *
 * @module
 */

import type { AnyCatalog, FeatureKey } from "../catalog.ts";
import type { Entitlements } from "../engine.ts";
import type { CheckResult } from "../schema.ts";
import {
  createFetchHandler,
  type CreateFetchHandlerResult,
  type EntitlementsPanelOptions,
} from "../server/create-fetch-handler.ts";
import { guardFetch, type RequireEntitlementOptions } from "./guard.ts";

/** Create a Bun-ready panel handler (`fetch` + `engine` + `openapi`). */
export function entitlementsPanel<const C extends AnyCatalog = AnyCatalog>(
  options: EntitlementsPanelOptions<C>,
): CreateFetchHandlerResult<C> {
  return createFetchHandler(options);
}

/** A Bun route handler that also receives the allowing decision. */
export type GuardedBunHandler = (
  request: Request,
  decision: CheckResult,
) => Response | Promise<Response>;

/**
 * Guard a Bun route: resolve the customer from the `Request`, check (or
 * consume) `feature`, answer `402` / `403` JSON when denied (`401` when no
 * customer), otherwise call the handler with the decision. Returns a wrapper
 * to apply to handlers.
 */
export function requireEntitlement<C extends AnyCatalog>(
  engine: Entitlements<C>,
  feature: FeatureKey<C>,
  options: RequireEntitlementOptions<Request>,
): (handler: GuardedBunHandler) => (request: Request) => Promise<Response> {
  return (handler) => guardFetch(engine, feature, options, handler);
}

export type { CreateFetchHandlerResult, EntitlementsPanelOptions, RequireEntitlementOptions };
