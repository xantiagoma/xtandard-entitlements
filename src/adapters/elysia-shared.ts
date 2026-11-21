/**
 * Elysia-version-agnostic pieces shared by the 1.x (`./elysia.ts`) and 2.x
 * (`./elysia2.ts`) adapters. Must not import `elysia`: each adapter's types are
 * built against a different major.
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

/** A web-standard fetch handler with `engine` + `openapi()` attached. */
export interface ElysiaEntitlementsHandler<C extends AnyCatalog = AnyCatalog> {
  /** Handle a request (what `Elysia.mount(path, handler)` calls). */
  (request: Request): Promise<Response>;
  /** The engine (given or constructed). */
  engine: Entitlements<C>;
  /** The HTTP API as an OpenAPI 3.1 document (also served at `{basePath}/api/openapi.json`). */
  openapi(): Record<string, unknown>;
  /** Stop the sweep timer. */
  close(): void;
}

/** Create a panel handler suitable for `Elysia.mount(path, handler)`. */
export function entitlementsPanel<const C extends AnyCatalog = AnyCatalog>(
  options: EntitlementsPanelOptions<C>,
): ElysiaEntitlementsHandler<C> {
  const handler = createFetchHandler(options);
  const fn = ((request: Request) => handler.fetch(request)) as ElysiaEntitlementsHandler<C>;
  fn.engine = handler.engine;
  fn.openapi = handler.openapi;
  fn.close = handler.close;
  return fn;
}

/** Options for `entitlementsElysia`. */
export interface EntitlementsElysiaOptions<
  C extends AnyCatalog = AnyCatalog,
> extends EntitlementsPanelOptions<C> {
  /** Mount prefix; also used as the panel basePath. Default `"/billing"`. */
  prefix?: string;
}

/**
 * Build the handlers every declared route delegates to. Elysia parses the body
 * for declared routes, draining the stream; `pass` rebuilds the Request from
 * the parsed body before delegating (mirrors the Express adapter). `raw` is for
 * the billing intake, whose signature is computed over the untouched body.
 */
export function createPass<C extends AnyCatalog>(
  options: EntitlementsElysiaOptions<C>,
): {
  prefix: string;
  handler: CreateFetchHandlerResult<C>;
  pass: (ctx: { request: Request; body?: unknown }) => Promise<Response>;
  raw: (ctx: { request: Request }) => Promise<Response>;
} {
  const prefix = options.prefix ?? "/billing";
  const handler = createFetchHandler({ ...options, basePath: options.basePath ?? prefix });

  const pass = (ctx: { request: Request; body?: unknown }): Promise<Response> => {
    const r = ctx.request;
    if (ctx.body != null && (r.method === "POST" || r.method === "PUT" || r.method === "PATCH")) {
      const headers = new Headers(r.headers);
      headers.set("content-type", "application/json");
      headers.delete("content-length");
      return handler.fetch(
        new Request(r.url, { method: r.method, headers, body: JSON.stringify(ctx.body) }),
      );
    }
    return handler.fetch(r);
  };
  const raw = (ctx: { request: Request }): Promise<Response> => handler.fetch(ctx.request);

  return { prefix, handler, pass, raw };
}

/** The minimal Elysia context the guard reads / writes (both majors). */
export interface ElysiaGuardContext {
  request: Request;
  /** Set by the guard for the allowed decision. */
  entitlement?: CheckResult;
  [key: string]: unknown;
}

/**
 * An Elysia `beforeHandle` guard (works on 1.x and 2.x): answers `402` / `403`
 * JSON for denials, `401` without a customer; for an allowed request it sets
 * `ctx.entitlement` and lets the handler run.
 *
 * ```ts
 * app.post("/export", ({ entitlement }) => ({ ok: true }), {
 *   beforeHandle: requireEntitlement(ent, "export_pdf", {
 *     customer: ({ request }) => request.headers.get("x-org-id"),
 *   }),
 * });
 * ```
 */
export function requireEntitlement<
  C extends AnyCatalog,
  Ctx extends ElysiaGuardContext = ElysiaGuardContext,
>(
  engine: Entitlements<C>,
  feature: FeatureKey<C>,
  options: RequireEntitlementOptions<Ctx>,
): (ctx: Ctx) => Promise<Response | undefined> {
  return async (ctx) => {
    const outcome = await evaluateGuard(engine, feature, options, ctx);
    if (!outcome.allowed) return outcomeResponse(outcome, options, ctx);
    ctx.entitlement = outcome.result;
    return undefined;
  };
}

export type { EntitlementsPanelOptions, RequireEntitlementOptions };
