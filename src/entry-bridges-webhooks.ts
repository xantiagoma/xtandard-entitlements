/**
 * Webhooks bridge (ADR 0013): `webhooksEvents(webhooks)` publishes plan
 * changes, trials, grants, overrides and usage thresholds through
 * `@xtandard/webhooks` — structural types, no runtime dependency.
 *
 * @module bridges/webhooks
 */
export { ENTITLEMENTS_EVENT_TYPES, webhooksEvents } from "./bridges/webhooks.ts";
export type {
  WebhooksEventsBridge,
  WebhooksEventsOptions,
  WebhooksPublisherLike,
  WebhooksPublishInputLike,
} from "./bridges/webhooks.ts";
