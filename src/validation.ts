/**
 * Runtime validation of HTTP API inputs, built on `valibot`.
 *
 * This is the **admin / API path** only: the engine's hot path (`check`,
 * `consume`) and the zero-dependency catalog never import it, so `valibot`
 * stays off the request path of embedded use. Schemas check shape and types;
 * semantic checks (unknown plan, feature kind, limits) stay in the engine and
 * surface as {@link EntitlementsValidationError}s too.
 *
 * @module
 */

import {
  jsonObjectSchema as kitJsonObjectSchema,
  jsonValueSchema as kitJsonValueSchema,
  parseInput as kitParseInput,
  type ValidationIssue,
} from "@xtandard/kit/util";
import * as v from "valibot";
import type { JsonObject, JsonValue } from "./catalog.ts";
import { durationToMs, type Duration } from "./duration.ts";
import { EntitlementsValidationError } from "./engine.ts";
import type { SubscriptionStatus } from "./schema.ts";

export type { ValidationIssue } from "@xtandard/kit/util";

/**
 * Input failed schema validation. An {@link EntitlementsValidationError} (so it
 * maps to HTTP 400) carrying the individual `issues` — the API answers
 * `400 { error, issues }`.
 */
export class InputValidationError extends EntitlementsValidationError {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[], message?: string) {
    super(
      message ??
        `Invalid input: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`,
    );
    this.issues = issues;
  }
}

/** Any JSON value (numbers must be finite). */
const jsonValueSchema = kitJsonValueSchema as v.GenericSchema<JsonValue>;

/** A JSON object (numbers must be finite). */
const jsonObjectSchema = kitJsonObjectSchema as v.GenericSchema<unknown, JsonObject>;

const nonEmpty = v.pipe(v.string(), v.minLength(1, "must be a non-empty string"));
const isoTime = v.pipe(
  v.string(),
  v.check((s) => !Number.isNaN(Date.parse(s)), "must be an ISO-8601 date-time"),
);
const finite = v.pipe(v.number(), v.finite("must be a finite number"));
const nonNegative = v.pipe(finite, v.minValue(0, "must be >= 0"));
const positiveInt = v.pipe(
  v.number(),
  v.integer("must be an integer"),
  v.minValue(1, "must be >= 1"),
);

const STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "trialing",
  "past_due",
  "paused",
  "canceled",
  "incomplete",
];
const statusSchema = v.picklist(STATUSES as SubscriptionStatus[]);

const durationSchema = v.pipe(
  v.union([v.number(), v.string()]),
  v.check((d) => {
    try {
      durationToMs(d as Duration);
      return true;
    } catch {
      return false;
    }
  }, 'must be milliseconds or a duration like "30s", "5m", "1h"'),
) as v.GenericSchema<Duration>;

/** `PATCH /api/customers/:id`. */
export const customerPatchSchema = v.strictObject({
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  metadata: v.optional(jsonObjectSchema),
});

/** `POST /api/customers/:id/subscriptions` (`SubscribeInput`). */
export const subscribeSchema = v.strictObject({
  plan: nonEmpty,
  version: v.optional(positiveInt),
  quantity: v.optional(nonNegative),
  status: v.optional(statusSchema),
  trialEndsAt: v.optional(isoTime),
  metadata: v.optional(jsonObjectSchema),
  replace: v.optional(v.boolean()),
});

/** `PATCH /api/customers/:id/subscriptions/:sid` (`Partial<SubscriptionInput>`, no `id`). */
export const subscriptionPatchSchema = v.strictObject({
  plan: v.optional(nonEmpty),
  version: v.optional(positiveInt),
  kind: v.optional(v.picklist(["plan", "addon"])),
  status: v.optional(statusSchema),
  quantity: v.optional(nonNegative),
  periodStart: v.optional(isoTime),
  periodEnd: v.optional(isoTime),
  trialEndsAt: v.optional(isoTime),
  cancelAtPeriodEnd: v.optional(v.boolean()),
  canceledAt: v.optional(isoTime),
  provider: v.optional(nonEmpty),
  providerRef: v.optional(v.string()),
  providerUpdatedAt: v.optional(isoTime),
  metadata: v.optional(jsonObjectSchema),
});

/** `POST /api/customers/:id/subscriptions/:sid/cancel`. */
export const cancelSchema = v.strictObject({ atPeriodEnd: v.optional(v.boolean()) });

/** `POST /api/customers/:id/trials`. */
export const trialSchema = v.strictObject({
  plan: nonEmpty,
  days: v.optional(positiveInt),
  force: v.optional(v.boolean()),
});

/** `POST /api/customers/:id/grants` (`GrantInput`). */
export const grantSchema = v.strictObject({
  feature: nonEmpty,
  amount: v.pipe(finite, v.gtValue(0, "must be > 0")),
  recurring: v.optional(v.boolean()),
  priority: v.optional(finite),
  startsAt: v.optional(isoTime),
  expiresAt: v.optional(isoTime),
  reason: v.optional(v.string()),
  metadata: v.optional(jsonObjectSchema),
});

/** `POST /api/customers/:id/overrides` (`OverrideInput`). */
export const overrideSchema = v.strictObject({
  feature: nonEmpty,
  enabled: v.optional(v.boolean()),
  limit: v.optional(v.nullable(nonNegative)),
  overage: v.optional(v.picklist(["block", "allow"])),
  value: v.optional(jsonValueSchema),
  startsAt: v.optional(isoTime),
  expiresAt: v.optional(isoTime),
  reason: v.optional(v.string()),
});

/** `PUT /api/customers/:id/usage/:feature`. */
export const setUsageSchema = v.strictObject({ value: nonNegative });

/** `POST /api/plans/:plan/migrate`. */
export const migrateSchema = v.strictObject({
  toVersion: v.optional(positiveInt),
  customer: v.optional(nonEmpty),
});

/** `POST /api/customers/:id/reconcile`. */
export const reconcileSchema = v.strictObject({ provider: v.optional(nonEmpty) });

/** `POST /api/v1/check`. */
export const runtimeCheckSchema = v.strictObject({
  customer: nonEmpty,
  feature: nonEmpty,
  amount: v.optional(nonNegative),
});

/** `POST /api/v1/consume`. */
export const runtimeConsumeSchema = v.strictObject({
  customer: nonEmpty,
  feature: nonEmpty,
  amount: v.optional(nonNegative),
  idempotencyKey: v.optional(nonEmpty),
});

/** `POST /api/v1/release`. */
export const runtimeReleaseSchema = runtimeCheckSchema;

/** `POST /api/v1/reserve`. */
export const runtimeReserveSchema = v.strictObject({
  customer: nonEmpty,
  feature: nonEmpty,
  amount: nonNegative,
  ttl: v.optional(durationSchema),
});

/** `POST /api/v1/settle`. */
export const runtimeSettleSchema = v.strictObject({
  reservationId: nonEmpty,
  actual: nonNegative,
  overage: v.optional(v.picklist(["record", "cap"])),
});

/** `POST /api/portal/checkout`. */
export const portalCheckoutSchema = v.strictObject({
  plan: nonEmpty,
  quantity: v.optional(positiveInt),
  successUrl: v.optional(v.string()),
  cancelUrl: v.optional(v.string()),
});

/** `POST /api/portal/manage`. */
export const portalManageSchema = v.strictObject({ returnUrl: v.optional(v.string()) });

/**
 * Validate `input` against `schema`; return the typed output or throw an
 * {@link InputValidationError} listing every issue.
 *
 * @example
 * ```ts
 * const grant = parseInput(grantSchema, await request.json());
 * ```
 */
export function parseInput<S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> {
  return kitParseInput(schema, input, { error: (issues) => new InputValidationError(issues) });
}
