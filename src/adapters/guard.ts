/**
 * Framework-agnostic core of the `requireEntitlement` guards (ADR 0009): resolve
 * the customer from the framework's request context, `check` (or `consume`)
 * the feature, and either hand the decision on or answer the denial as JSON —
 * `402 Payment Required` when an upgrade would allow it, `403 Forbidden`
 * otherwise, `401` when no customer could be resolved. Every adapter wraps
 * this; it imports no framework.
 *
 * @module
 */

import type { AnyCatalog, FeatureKey } from "../catalog.ts";
import { EntitlementDeniedError, type Entitlements } from "../engine.ts";
import type { CheckResult } from "../schema.ts";

/** A value, or a function of the framework context producing it (sync or async). */
export type FromContext<Ctx, T> = T | ((ctx: Ctx) => T | Promise<T>);

/** Options shared by every framework's `requireEntitlement` guard. */
export interface RequireEntitlementOptions<Ctx> {
  /**
   * The customer (your user / org / workspace id) for this request. Return
   * `null` / `undefined` / `""` when there is none → `401`.
   */
  customer: (ctx: Ctx) => string | null | undefined | Promise<string | null | undefined>;
  /** Units to check / consume. Default `1`. */
  amount?: FromContext<Ctx, number>;
  /**
   * `true` → `consume` the amount atomically (a refusal never counts);
   * default `false` → `check` only.
   */
  consume?: boolean;
  /** Idempotency key for `consume` (e.g. from an `idempotency-key` header). */
  idempotencyKey?: (ctx: Ctx) => string | null | undefined;
  /**
   * Build the denial response yourself (e.g. an HTML upsell page). Default:
   * {@link denialResponse}.
   */
  onDenied?: (result: CheckResult, ctx: Ctx) => Response | Promise<Response>;
}

/** Outcome of {@link evaluateGuard}: the decision to attach, or the response to send. */
export type GuardOutcome =
  | { allowed: true; result: CheckResult }
  | { allowed: false; result: CheckResult | null; status: number; body: Record<string, unknown> };

/** The JSON body and status for a denied decision (`{ error, ...CheckResult }`). */
export function denialOf(result: CheckResult): {
  status: 402 | 403;
  body: Record<string, unknown>;
} {
  const denied = new EntitlementDeniedError(result);
  return { status: denied.status, body: { error: denied.message, ...result } };
}

/** A web `Response` for a denied decision (402 / 403 JSON). */
export function denialResponse(result: CheckResult): Response {
  const { status, body } = denialOf(result);
  return Response.json(body, { status });
}

const UNAUTHORIZED = {
  status: 401,
  body: { error: "Unauthorized: no customer for this request" },
} as const;

/**
 * Run the guard for one request context. Never throws for a denial; errors
 * from the `customer` / `amount` resolvers or the engine propagate.
 */
export async function evaluateGuard<C extends AnyCatalog, Ctx>(
  engine: Entitlements<C>,
  feature: FeatureKey<C>,
  options: RequireEntitlementOptions<Ctx>,
  ctx: Ctx,
): Promise<GuardOutcome> {
  const customer = await options.customer(ctx);
  if (!customer) return { allowed: false, result: null, ...UNAUTHORIZED };
  const amount =
    typeof options.amount === "function"
      ? await (options.amount as (ctx: Ctx) => number | Promise<number>)(ctx)
      : (options.amount ?? 1);
  let result: CheckResult;
  if (options.consume) {
    const key = options.idempotencyKey?.(ctx) ?? undefined;
    result = await engine.consume(customer, feature, amount, key ? { idempotencyKey: key } : {});
  } else {
    result = (await engine.check(customer, feature, { amount })) as CheckResult;
  }
  if (result.allowed) return { allowed: true, result };
  return { allowed: false, result, ...denialOf(result) };
}

/**
 * Turn a denied {@link GuardOutcome} into a web `Response` (honoring
 * `onDenied`).
 */
export async function outcomeResponse<Ctx>(
  outcome: Extract<GuardOutcome, { allowed: false }>,
  options: RequireEntitlementOptions<Ctx>,
  ctx: Ctx,
): Promise<Response> {
  if (outcome.result && options.onDenied) return options.onDenied(outcome.result, ctx);
  return Response.json(outcome.body, { status: outcome.status });
}

/**
 * Wrap a web-standard handler `(request, decision) => Response` with a guard —
 * the shape `Bun.serve` routes and Next.js route handlers share.
 */
export function guardFetch<C extends AnyCatalog, Extra extends unknown[] = []>(
  engine: Entitlements<C>,
  feature: FeatureKey<C>,
  options: RequireEntitlementOptions<Request>,
  handler: (
    request: Request,
    decision: CheckResult,
    ...extra: Extra
  ) => Response | Promise<Response>,
): (request: Request, ...extra: Extra) => Promise<Response> {
  return async (request, ...extra) => {
    const outcome = await evaluateGuard(engine, feature, options, request);
    if (!outcome.allowed) return outcomeResponse(outcome, options, request);
    return handler(request, outcome.result, ...extra);
  };
}
