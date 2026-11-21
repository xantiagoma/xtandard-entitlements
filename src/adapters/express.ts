/**
 * Express adapter. Express predates the web Fetch API, so
 * {@link entitlementsPanel} bridges Node's `req` / `res` to the web-standard
 * handler (build a `Request`, run the panel, write the `Response` back). No
 * `express` import at runtime — only its types.
 *
 * Mount the panel BEFORE any body-parser middleware (it reads the raw body —
 * billing webhook signatures are computed over it):
 *
 * ```ts
 * import express from "express";
 * import { entitlementsPanel, requireEntitlement } from "@xtandard/entitlements/express";
 *
 * const app = express();
 * const panel = entitlementsPanel({ catalog, basePath: "/billing" });
 * app.use("/billing", panel);
 * app.post(
 *   "/api/export",
 *   requireEntitlement(panel.engine, "export_pdf", { customer: (req) => req.get("x-org-id") }),
 *   (req, res) => res.json({ remaining: req.entitlement!.remaining }),
 * );
 * ```
 *
 * @module
 */

import type { NextFunction, Request as ExRequest, Response as ExResponse } from "express";
import type { AnyCatalog, FeatureKey } from "../catalog.ts";
import type { Entitlements } from "../engine.ts";
import type { CheckResult } from "../schema.ts";
import {
  createFetchHandler,
  type CreateFetchHandlerResult,
  type EntitlementsPanelOptions,
} from "../server/create-fetch-handler.ts";
import { evaluateGuard, type RequireEntitlementOptions } from "./guard.ts";

/** An Express request handler with the panel's `engine` + `openapi` attached. */
export type ExpressEntitlementsHandler<C extends AnyCatalog = AnyCatalog> = ((
  req: ExRequest,
  res: ExResponse,
  next: NextFunction,
) => void) & {
  engine: Entitlements<C>;
  openapi: CreateFetchHandlerResult<C>["openapi"];
  close: CreateFetchHandlerResult<C>["close"];
};

/** An Express request carrying the guard's decision. */
export type EntitlementRequest = ExRequest & { entitlement?: CheckResult };

function headersFrom(req: ExRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

async function readBody(req: ExRequest): Promise<Uint8Array | undefined> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  // If an upstream body parser already consumed the stream, re-serialize req.body
  // (admin routes still work; billing signatures over the raw body will not).
  if (req.readableEnded) {
    const body = (req as { body?: unknown }).body;
    if (body === undefined || body === null) return undefined;
    if (body instanceof Uint8Array) return body;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new TextEncoder().encode(text);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

function toWebRequest(req: ExRequest, body: Uint8Array | undefined): Request {
  const protocol = req.protocol || "http";
  const host = req.get?.("host") ?? req.headers.host ?? "localhost";
  // originalUrl preserves the mount prefix (e.g. /billing/api/...) and query string.
  const url = `${protocol}://${host}${req.originalUrl ?? req.url ?? "/"}`;
  return new Request(url, {
    method: req.method,
    headers: headersFrom(req),
    body: body as BodyInit | undefined,
  });
}

async function writeWebResponse(res: ExResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

/** Create an Express handler serving the panel. Use with `app.use(path, handler)`. */
export function entitlementsPanel<const C extends AnyCatalog = AnyCatalog>(
  options: EntitlementsPanelOptions<C>,
): ExpressEntitlementsHandler<C> {
  const handler = createFetchHandler(options);

  const middleware = (req: ExRequest, res: ExResponse, next: NextFunction): void => {
    (async () => {
      const body = await readBody(req);
      const response = await handler.fetch(toWebRequest(req, body));
      await writeWebResponse(res, response);
    })().catch(next);
  };

  return Object.assign(middleware, {
    engine: handler.engine,
    openapi: handler.openapi,
    close: handler.close,
  });
}

/**
 * Express middleware guarding a route with an entitlement (ADR 0009): `402` /
 * `403` JSON for denials, `401` without a customer; otherwise sets
 * `req.entitlement` (and `res.locals.entitlement`) and calls `next()`.
 */
export function requireEntitlement<C extends AnyCatalog>(
  engine: Entitlements<C>,
  feature: FeatureKey<C>,
  options: RequireEntitlementOptions<ExRequest>,
): (req: ExRequest, res: ExResponse, next: NextFunction) => void {
  return (req, res, next) => {
    (async () => {
      const outcome = await evaluateGuard(engine, feature, options, req);
      if (outcome.allowed) {
        (req as EntitlementRequest).entitlement = outcome.result;
        res.locals.entitlement = outcome.result;
        next();
        return;
      }
      if (outcome.result && options.onDenied) {
        await writeWebResponse(res, await options.onDenied(outcome.result, req));
        return;
      }
      res.status(outcome.status).json(outcome.body);
    })().catch(next);
  };
}

export type { EntitlementsPanelOptions, RequireEntitlementOptions };
