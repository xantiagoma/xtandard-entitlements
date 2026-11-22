/**
 * Next.js (App Router) adapter. No `next` import — route handlers are plain
 * web `Request` → `Response` functions.
 *
 * - {@link toNextHandler} turns a panel into the method exports of a
 *   catch-all route (`app/billing/[[...path]]/route.ts`).
 * - {@link withEntitlement} wraps a route handler with an entitlement guard:
 *   `402` / `403` JSON for denials (ADR 0009), `401` without a customer; the
 *   allowing decision is passed to the handler as `context.entitlement`.
 *
 * ```ts
 * // lib/entitlements.ts
 * export const panel = entitlementsPanel({ catalog, basePath: "/billing", storage, counters });
 *
 * // app/billing/[[...path]]/route.ts
 * import { toNextHandler } from "@xtandard/entitlements/next";
 * import { panel } from "@/lib/entitlements";
 * export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = toNextHandler(panel);
 *
 * // app/api/export/route.ts
 * import { withEntitlement } from "@xtandard/entitlements/next";
 * export const POST = withEntitlement(
 *   async (request, { entitlement }) => Response.json({ remaining: entitlement.remaining }),
 *   { engine: panel.engine, feature: "export_pdf", customer: async () => (await auth())?.orgId },
 * );
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
import { evaluateGuard, outcomeResponse, type RequireEntitlementOptions } from "./guard.ts";

/** `toNextHandler(panel)` turns a panel into App Router method exports (`GET`, `POST`, …). */
export {
  toNextHandler,
  type NextRouteHandler,
  type NextRouteHandlers,
} from "@xtandard/kit/adapters/next";

/** Create the panel (a `createFetchHandler` result) — pass it to {@link toNextHandler}. */
export function entitlementsPanel<const C extends AnyCatalog = AnyCatalog>(
  options: EntitlementsPanelOptions<C>,
): CreateFetchHandlerResult<C> {
  return createFetchHandler(options);
}

/** Options for {@link withEntitlement}. */
export interface WithEntitlementOptions<
  C extends AnyCatalog,
> extends RequireEntitlementOptions<Request> {
  engine: Entitlements<C>;
  feature: FeatureKey<C>;
}

/**
 * Wrap an App Router route handler with an entitlement guard. The handler's
 * second argument is Next's route context (`{ params }`) plus `entitlement`.
 */
export function withEntitlement<
  C extends AnyCatalog,
  Ctx extends object = { params: Promise<Record<string, string | string[]>> },
>(
  handler: (
    request: Request,
    context: Ctx & { entitlement: CheckResult },
  ) => Response | Promise<Response>,
  options: WithEntitlementOptions<C>,
): (request: Request, context: Ctx) => Promise<Response> {
  return async (request, context) => {
    const outcome = await evaluateGuard(options.engine, options.feature, options, request);
    if (!outcome.allowed) return outcomeResponse(outcome, options, request);
    return handler(request, { ...context, entitlement: outcome.result });
  };
}

export type { EntitlementsPanelOptions, RequireEntitlementOptions };
