/**
 * Webhooks bridge (ADR 0013): publish entitlements events — plan changes,
 * trials, cancellations, grants, overrides, usage resets and usage
 * thresholds ("80 % of quota") — as outbound webhooks through
 * `@xtandard/webhooks` (or anything with a compatible `publish`).
 *
 * The `webhooks` parameter is structural ({@link WebhooksPublisherLike});
 * this module imports nothing from `@xtandard/webhooks`. Register
 * {@link ENTITLEMENTS_EVENT_TYPES} in the webhooks catalog (it requires known
 * event types by default).
 *
 * @example
 * ```ts
 * import { createWebhooksCore } from "@xtandard/webhooks/core";
 * import { ENTITLEMENTS_EVENT_TYPES, webhooksEvents } from "@xtandard/entitlements/bridges/webhooks";
 *
 * const webhooks = createWebhooksCore({ storage });
 * for (const t of ENTITLEMENTS_EVENT_TYPES) await webhooks.upsertEventType(t);
 *
 * const bridge = webhooksEvents(webhooks); // application = the customer id
 * const ent = createEntitlements({ catalog, hooks: bridge.hooks, onThreshold: bridge.onThreshold });
 * ```
 *
 * @module bridges/webhooks
 */

import type { JsonValue } from "../catalog.ts";
import type { ThresholdListener, UsageEvent, UsageListener } from "../events.ts";
import type { AfterEvent, EntitlementsHooks } from "../hooks/contract.ts";
import { sha256Hex } from "../billing/verify.ts";
import { newId } from "../id.ts";

/** What the bridge passes to `webhooks.publish` (structural subset of `@xtandard/webhooks`'s `PublishInput`). */
export interface WebhooksPublishInputLike {
  eventType: string;
  payload: JsonValue;
  timestamp?: string;
  idempotencyKey?: string;
}

/** Anything with an `@xtandard/webhooks`-compatible `publish`. */
export interface WebhooksPublisherLike {
  publish(application: string, input: WebhooksPublishInputLike): Promise<unknown>;
}

/** Event types this bridge publishes (for the webhooks catalog: `upsertEventType`). */
export const ENTITLEMENTS_EVENT_TYPES: ReadonlyArray<{
  name: string;
  description: string;
  groupName: string;
}> = [
  ["subscription.changed", "A plan or add-on subscription was created or changed."],
  ["subscription.canceled", "A subscription moved to canceled."],
  ["subscription.removed", "A subscription was deleted."],
  ["trial.started", "A trial subscription started."],
  ["grant.created", "Usage balance was granted."],
  ["grant.revoked", "A grant was revoked."],
  ["override.created", "An operator override was added."],
  ["override.removed", "An operator override was removed."],
  ["usage.reset", "A feature's usage was reset."],
  ["usage.threshold", "Usage crossed a configured share of the limit (once per period)."],
  ["usage.recorded", "Usage was recorded (only with the `usage` option)."],
].map(([name, description]) => ({
  name: `entitlements.${name}`,
  description: description!,
  groupName: "Entitlements",
}));

/** Options for {@link webhooksEvents}. */
export interface WebhooksEventsOptions {
  /**
   * The webhooks application to publish to: a fixed key, or one per customer.
   * Default: the customer id (each customer is a webhooks application).
   */
  application?: string | ((customer: string) => string);
  /** Event type prefix. Default `"entitlements."`. */
  eventPrefix?: string;
  /** Also publish `entitlements.usage.recorded` for every usage change (`onUsage`). Default `false`. */
  usage?: boolean;
}

/** What {@link webhooksEvents} returns: wire `hooks`, `onThreshold` (and `onUsage`) into the engine. */
export interface WebhooksEventsBridge {
  hooks: EntitlementsHooks;
  onThreshold: ThresholdListener;
  /** Present when `usage: true`. */
  onUsage?: UsageListener;
}

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** `@xtandard/webhooks` idempotency keys allow `a-z A-Z 0-9 . _ -`, up to 256 chars. */
const safeKey = (key: string): string => key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 256);

/** Publish entitlements events to `@xtandard/webhooks`. */
export function webhooksEvents(
  webhooks: WebhooksPublisherLike,
  options: WebhooksEventsOptions = {},
): WebhooksEventsBridge {
  const prefix = options.eventPrefix ?? "entitlements.";
  const appOf =
    typeof options.application === "function"
      ? options.application
      : (customer: string) => (options.application as string | undefined) ?? customer;

  /**
   * Publish one event. `key` names the change; control-plane events append a
   * hash of the payload so a re-delivered identical change dedupes while two
   * different changes in the same millisecond never collide.
   */
  const publish = async (
    customer: string,
    type: string,
    payload: unknown,
    at: string,
    key: string,
    exact = false,
  ) => {
    const body = json(payload);
    const suffix = exact ? "" : `.${(await sha256Hex(JSON.stringify(body))).slice(0, 16)}`;
    await webhooks.publish(appOf(customer), {
      eventType: `${prefix}${type}`,
      payload: body,
      timestamp: at,
      idempotencyKey: safeKey(`${prefix}${type}.${key}${suffix}`),
    });
  };

  async function onAfter(event: AfterEvent): Promise<void> {
    const c = event.customer;
    switch (event.type) {
      case "subscription.changed": {
        const s = event.subscription;
        const p = event.previous;
        const key = s.id;
        const payload = { customer: c, subscription: s, ...(p ? { previous: p } : {}) };
        await publish(c, "subscription.changed", payload, event.at, key);
        if (s.status === "trialing" && p?.status !== "trialing") {
          await publish(c, "trial.started", payload, event.at, key);
        }
        if (s.status === "canceled" && p && p.status !== "canceled") {
          await publish(c, "subscription.canceled", payload, event.at, key);
        }
        return;
      }
      case "subscription.removed":
        return void (await publish(
          c,
          event.type,
          { customer: c, subscription: event.subscription },
          event.at,
          event.subscription.id,
        ));
      case "grant.created":
      case "grant.revoked":
        return void (await publish(
          c,
          event.type,
          { customer: c, grant: event.grant },
          event.at,
          event.grant.id,
        ));
      case "override.created":
      case "override.removed":
        return void (await publish(
          c,
          event.type,
          { customer: c, override: event.override },
          event.at,
          event.override.id,
        ));
      case "usage.reset":
        return void (await publish(
          c,
          event.type,
          { customer: c, feature: event.feature, at: event.at },
          event.at,
          `${c}:${event.feature}`,
        ));
      default:
        return;
    }
  }

  const bridge: WebhooksEventsBridge = {
    hooks: { after: onAfter },
    onThreshold: (e) =>
      publish(
        e.customer,
        "usage.threshold",
        e,
        e.at,
        `${e.customer}:${e.feature}:${e.period}:${e.threshold}`,
        true,
      ),
  };
  if (options.usage) {
    bridge.onUsage = (e: UsageEvent) =>
      publish(
        e.customer,
        "usage.recorded",
        {
          customer: e.customer,
          feature: e.feature,
          amount: e.amount,
          source: e.source,
          remaining: e.result.remaining ?? null,
          used: e.result.used ?? null,
        },
        e.at,
        e.idempotencyKey
          ? `${e.customer}:${e.feature}:${e.idempotencyKey}`
          : e.reservationId
            ? `${e.reservationId}:${e.source}`
            : newId("use"),
        true,
      );
  }
  return bridge;
}
