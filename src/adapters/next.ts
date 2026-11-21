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

/** A Next.js App Router route handler. */
export type NextRouteHandler<Ctx = unknown> = (request: Request, context: Ctx) => Promise<Response>;

/** The method exports of a catch-all route. */
export interface NextRouteHandlers {
  GET: NextRouteHandler;
  HEAD: NextRouteHandler;
  POST: NextRouteHandler;
  PUT: NextRouteHandler;
  PATCH: NextRouteHandler;
  DELETE: NextRouteHandler;
  OPTIONS: NextRouteHandler;
}

/** Create the panel (a `createFetchHandler` result) — pass it to {@link toNextHandler}. */
export function entitlementsPanel<const C extends AnyCatalog = AnyCatalog>(
  options: EntitlementsPanelOptions<C>,
): CreateFetchHandlerResult<C> {
  return createFetchHandler(options);
}

/**
 * Turn a panel (anything with a web `fetch`) into App Router method exports.
 * Set the panel's `basePath` to the route's mount (e.g. `"/billing"` for
 * `app/billing/[[...path]]/route.ts`).
 */
export function toNextHandler(panel: {
  fetch(request: Request): Promise<Response>;
}): NextRouteHandlers {
  const handle: NextRouteHandler = (request) => panel.fetch(request);
  return {
    GET: handle,
    HEAD: handle,
    POST: handle,
    PUT: handle,
    PATCH: handle,
    DELETE: handle,
    OPTIONS: handle,
  };
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
