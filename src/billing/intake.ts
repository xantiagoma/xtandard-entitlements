/**
 * The billing intake (ADR 0007): `createBilling(engine, { providers })` binds
 * provider adapters to an engine.
 *
 * - **Verify** — `provider.parseWebhook(request)` checks the signature and
 *   normalizes the payload (throws `BillingVerificationError` → HTTP 400).
 * - **Idempotency** — every delivery claims `evt/{provider}/{eventId}` in the
 *   counter store for 7 days; a duplicate is answered `"duplicate"` without
 *   touching state. When applying fails the claim is released so the
 *   provider's retry is processed.
 * - **Customer resolution** — our id from the provider (Stripe
 *   `client_reference_id`, Polar `external_id`) or subscription metadata
 *   (`metadataKey`, default `"customerId"`), else the link table
 *   (`links/{provider}/{providerCustomer}`). A first sighting links them.
 * - **Mapping** — provider item ids → catalog plans / add-ons / plan versions
 *   via `catalog.normalized.providerIndex` (legacy price ids land on the
 *   version they were mapped to). Unknown items are skipped and reported
 *   through `onUnmapped`.
 * - **Ordering** — writes carry `providerUpdatedAt`; the engine ignores an
 *   update older than what it already holds (`"stale"`).
 *
 * @example
 * ```ts
 * import { createBilling } from "@xtandard/entitlements/billing";
 * import { createStripeProvider } from "@xtandard/entitlements/billing/stripe";
 *
 * const billing = createBilling(ent, {
 *   providers: [createStripeProvider({ secretKey, webhookSecret })],
 * });
 * // POST /webhooks/stripe
 * const { outcome } = await billing.handleWebhook("stripe", request);
 * ```
 *
 * @module
 */

import type { NormalizedAddon, NormalizedPlan } from "../catalog.ts";
import { durationToMs, type Duration } from "../duration.ts";
import {
  EntitlementsValidationError,
  NotFoundError,
  type Entitlements,
  type SubscriptionInput,
} from "../engine.ts";
import { eventKey } from "../keys.ts";
import type { Actor, CustomerState, JsonObject, Subscription } from "../schema.ts";
import type {
  BillingEvent,
  BillingProvider,
  EntitlementsBilling,
  IntakeOutcome,
  ProviderItem,
  ProviderSubscription,
  ReconcileResult,
} from "./contract.ts";

/** Why {@link BillingOptions.onUnmapped} was called. */
export type UnmappedEvent =
  | {
      reason: "unknown_item";
      provider: string;
      /** Our customer id (resolved). */
      customer: string;
      item: ProviderItem;
      subscription: ProviderSubscription;
    }
  | {
      reason: "unknown_customer";
      provider: string;
      providerCustomer: string;
      subscription: ProviderSubscription;
    };

/** Options for {@link createBilling}. */
export interface BillingOptions {
  /** Provider adapters (`createStripeProvider(…)`, `createPolarProvider(…)`, …). Ids must be unique. */
  providers: readonly BillingProvider[];
  /** Subscription-metadata key carrying our customer id. Default `"customerId"`. */
  metadataKey?: string;
  /**
   * Called for a provider item the catalog does not map (the item is ignored),
   * and for a subscription whose customer cannot be resolved. Default: a
   * `logger.warn`.
   */
  onUnmapped?: (event: UnmappedEvent) => void;
  /** How long processed webhook event ids are remembered. Default `"7d"`. */
  eventTtl?: Duration;
  /** Non-fatal problems. Default `console.warn`. */
  logger?: { warn(message: string, error?: unknown): void };
  /** Clock (unix ms) for cancellation / reconcile stamps — pass the engine's. Default `Date.now`. */
  now?: () => number;
}

/** Per-subscription apply result (internal, also summed by reconcile). */
interface ApplyCounts {
  outcome: IntakeOutcome;
  upserted: number;
  canceled: number;
}

const rank: Record<IntakeOutcome, number> = { ignored: 0, duplicate: 0, stale: 1, applied: 2 };
const merge = (a: IntakeOutcome, b: IntakeOutcome): IntakeOutcome => (rank[b] > rank[a] ? b : a);

const isLive = (s: Subscription) => s.status !== "canceled";

/**
 * Bind billing providers to an engine. The returned {@link EntitlementsBilling}
 * is what the panel's `POST /webhooks/:provider`, `/api/portal/checkout|manage`
 * and `/api/customers/:id/reconcile` routes call.
 */
export function createBilling(engine: Entitlements, options: BillingOptions): EntitlementsBilling {
  const providers = new Map<string, BillingProvider>();
  for (const p of options.providers) {
    if (!p?.id) throw new EntitlementsValidationError("billing provider without an id");
    if (providers.has(p.id)) {
      throw new EntitlementsValidationError(`billing provider "${p.id}" is configured twice`);
    }
    providers.set(p.id, p);
  }
  const metadataKey = options.metadataKey ?? "customerId";
  const eventTtl = durationToMs(options.eventTtl ?? "7d");
  const logger = options.logger ?? {
    warn: (message: string, error?: unknown) =>
      console.warn(`[@xtandard/entitlements] ${message}`, ...(error === undefined ? [] : [error])),
  };
  const onUnmapped =
    options.onUnmapped ??
    ((e: UnmappedEvent) =>
      logger.warn(
        e.reason === "unknown_item"
          ? `billing: ${e.provider} item "${e.item.id}" is not mapped to a plan or add-on (subscription ${e.subscription.ref}); ignored`
          : `billing: ${e.provider} customer "${e.providerCustomer}" is not linked to a customer (subscription ${e.subscription.ref}); ignored`,
      ));
  const n = engine.catalog.normalized;
  const actorFor = (provider: string): Actor => ({ id: provider, type: `billing:${provider}` });
  const now = options.now ?? Date.now;
  const nowIso = () => new Date(now()).toISOString();

  function providerOrThrow(id: string): BillingProvider {
    const p = providers.get(id);
    if (!p) throw new NotFoundError(`Unknown billing provider "${id}"`);
    return p;
  }

  /** Our customer id for a provider subscription; links on first sight. */
  async function resolveCustomer(
    provider: string,
    providerCustomer: string,
    explicit: string | undefined,
  ): Promise<string | null> {
    if (explicit) {
      if (providerCustomer && (await engine.resolveLink(provider, providerCustomer)) !== explicit) {
        await engine.link(explicit, provider, providerCustomer);
      }
      return explicit;
    }
    return providerCustomer ? engine.resolveLink(provider, providerCustomer) : null;
  }

  const metadataCustomer = (sub: ProviderSubscription): string | undefined => {
    const v = sub.metadata?.[metadataKey];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  /** Cancel this provider subscription's entries that are not in `keep`. */
  async function cancelMissing(
    customer: string,
    provider: string,
    belongs: (s: Subscription) => boolean,
    keep: ReadonlySet<string>,
    at: string,
    providerUpdatedAt: string | undefined,
  ): Promise<number> {
    const state = await engine.getCustomer(customer);
    let canceled = 0;
    for (const s of state?.subscriptions ?? []) {
      if (s.provider !== provider || !s.providerRef || keep.has(s.providerRef)) continue;
      if (!belongs(s) || !isLive(s)) continue;
      const r = await engine.upsertSubscription(
        customer,
        {
          id: s.id,
          plan: s.plan,
          kind: s.kind,
          provider,
          providerRef: s.providerRef,
          status: "canceled",
          canceledAt: at,
          ...(providerUpdatedAt ? { providerUpdatedAt } : {}),
        },
        { actor: actorFor(provider) },
      );
      if (r.outcome !== "stale") canceled++;
    }
    return canceled;
  }

  /** Map one normalized provider subscription onto engine subscriptions. */
  async function applySubscription(
    provider: string,
    sub: ProviderSubscription,
    deleted: boolean,
    forcedCustomer?: string,
  ): Promise<ApplyCounts> {
    const customer =
      forcedCustomer ??
      (await resolveCustomer(
        provider,
        sub.providerCustomer,
        sub.customer ?? metadataCustomer(sub),
      ));
    if (!customer) {
      onUnmapped({
        reason: "unknown_customer",
        provider,
        providerCustomer: sub.providerCustomer,
        subscription: sub,
      });
      return { outcome: "ignored", upserted: 0, canceled: 0 };
    }
    const at = nowIso();
    const status = deleted ? "canceled" : sub.status;
    const mapped: Array<{ item: ProviderItem; input: SubscriptionInput }> = [];
    let planRefUsed = false;
    for (const item of sub.items) {
      const target = n.providerIndex.get(`${provider}:${item.id}`);
      if (!target) {
        onUnmapped({ reason: "unknown_item", provider, customer, item, subscription: sub });
        continue;
      }
      // The (first) plan item owns the subscription ref; add-on items get their own.
      const ownRef = target.type === "plan" && !planRefUsed;
      if (ownRef) planRefUsed = true;
      const input: SubscriptionInput = {
        plan: target.key,
        kind: target.type,
        status,
        quantity: item.quantity,
        provider,
        providerRef: ownRef ? sub.ref : `${sub.ref}:${item.itemRef ?? item.id}`,
      };
      if (target.type === "plan" && target.version !== undefined) input.version = target.version;
      if (sub.periodStart) input.periodStart = sub.periodStart;
      if (sub.periodEnd) input.periodEnd = sub.periodEnd;
      if (sub.trialEndsAt) input.trialEndsAt = sub.trialEndsAt;
      if (sub.cancelAtPeriodEnd !== undefined) input.cancelAtPeriodEnd = sub.cancelAtPeriodEnd;
      if (sub.canceledAt) input.canceledAt = sub.canceledAt;
      else if (status === "canceled") input.canceledAt = at;
      if (sub.updatedAt) input.providerUpdatedAt = sub.updatedAt;
      if (sub.metadata && Object.keys(sub.metadata).length > 0) {
        input.metadata = sub.metadata as JsonObject;
      }
      mapped.push({ item, input });
    }
    const ofThisSubscription = (s: Subscription) =>
      s.providerRef === sub.ref || s.providerRef!.startsWith(`${sub.ref}:`);
    if (mapped.length === 0) {
      // Nothing we know about. Leave existing entries alone (an all-unknown
      // payload is more likely a catalog gap than a real removal) — unless the
      // provider says the whole subscription is gone.
      const canceled = deleted
        ? await cancelMissing(customer, provider, ofThisSubscription, new Set(), at, sub.updatedAt)
        : 0;
      return { outcome: canceled > 0 ? "applied" : "ignored", upserted: 0, canceled };
    }
    let outcome: IntakeOutcome = "ignored";
    let upserted = 0;
    const refs = new Set<string>();
    for (const { input } of mapped) {
      refs.add(input.providerRef!);
      const r = await engine.upsertSubscription(customer, input, { actor: actorFor(provider) });
      if (r.outcome === "stale") outcome = merge(outcome, "stale");
      else {
        outcome = merge(outcome, "applied");
        upserted++;
      }
    }
    let canceled = 0;
    if (outcome === "applied") {
      // Items that left the subscription (an add-on removed, the plan item
      // swapped for an unmapped one) → their entries are canceled.
      canceled = await cancelMissing(
        customer,
        provider,
        ofThisSubscription,
        refs,
        at,
        sub.updatedAt,
      );
    }
    return { outcome, upserted, canceled };
  }

  async function applyCustomer(
    provider: string,
    event: Extract<BillingEvent, { type: "customer.updated" }>,
  ): Promise<IntakeOutcome> {
    const customer = await resolveCustomer(provider, event.providerCustomer, event.customer);
    if (!customer) return "ignored";
    const state = await engine.getCustomer(customer);
    const patch: { email?: string; name?: string } = {};
    if (event.email && state?.email !== event.email) patch.email = event.email;
    if (event.name && state?.name !== event.name) patch.name = event.name;
    if (Object.keys(patch).length > 0) {
      await engine.updateCustomer(customer, patch, { actor: actorFor(provider) });
    }
    return "applied";
  }

  async function applyEvents(provider: string, events: BillingEvent[]): Promise<IntakeOutcome> {
    let outcome: IntakeOutcome = "ignored";
    for (const event of events) {
      switch (event.type) {
        case "subscription.updated":
        case "subscription.deleted":
          outcome = merge(
            outcome,
            (
              await applySubscription(
                provider,
                event.subscription,
                event.type === "subscription.deleted",
              )
            ).outcome,
          );
          break;
        case "customer.updated":
          outcome = merge(outcome, await applyCustomer(provider, event));
          break;
        default:
          break;
      }
    }
    return outcome;
  }

  const billing: EntitlementsBilling = {
    providers: [...providers.keys()],

    async handleWebhook(provider, request) {
      const p = providerOrThrow(provider);
      if (!p.parseWebhook) {
        throw new NotFoundError(`Billing provider "${provider}" does not receive webhooks`);
      }
      const webhook = await p.parseWebhook(request);
      // Payloads without a provider-side update time are ordered by event time.
      const events = webhook.createdAt
        ? webhook.events.map((e) =>
            (e.type === "subscription.updated" || e.type === "subscription.deleted") &&
            !e.subscription.updatedAt
              ? { ...e, subscription: { ...e.subscription, updatedAt: webhook.createdAt } }
              : e,
          )
        : webhook.events;
      const outcome = await billing.apply(provider, events, { eventId: webhook.id });
      return { outcome, events: webhook.events.length };
    },

    async apply(provider, events, o = {}) {
      providerOrThrow(provider);
      const claimKey = o.eventId ? eventKey(provider, o.eventId) : undefined;
      if (claimKey && !(await engine.counters.claim(claimKey, eventTtl))) return "duplicate";
      try {
        return await applyEvents(provider, events);
      } catch (error) {
        if (claimKey) await engine.counters.release(claimKey).catch(() => {});
        throw error;
      }
    },

    async reconcile(customer, provider) {
      const state = await engine.getCustomer(customer);
      const ids = provider
        ? [providerOrThrow(provider).id]
        : [...providers.values()].filter((p) => p.fetchSubscriptions).map((p) => p.id);
      const results: ReconcileResult[] = [];
      for (const id of ids) {
        const p = providers.get(id)!;
        const result: ReconcileResult = { customer, provider: id, upserted: 0, canceled: 0 };
        results.push(result);
        const providerCustomer = state?.providers[id];
        if (!p.fetchSubscriptions || !providerCustomer) continue;
        const subs = await p.fetchSubscriptions(providerCustomer);
        const at = nowIso();
        const seen = new Set<string>();
        for (const sub of subs) {
          seen.add(sub.ref);
          const counts = await applySubscription(
            id,
            { ...sub, updatedAt: sub.updatedAt ?? at },
            false,
            customer,
          );
          result.upserted += counts.upserted;
          result.canceled += counts.canceled;
        }
        // Subscriptions the provider no longer reports at all.
        const baseRef = (ref: string) => ref.split(":")[0]!;
        const fresh = await engine.getCustomer(customer);
        const gone = new Set(
          (fresh?.subscriptions ?? [])
            .filter((s) => s.provider === id && s.providerRef && !seen.has(baseRef(s.providerRef)))
            .map((s) => s.providerRef!),
        );
        if (gone.size > 0) {
          result.canceled += await cancelMissing(
            customer,
            id,
            (s) => gone.has(s.providerRef!),
            new Set(),
            at,
            undefined,
          );
        }
      }
      return results;
    },

    async createCheckout(customer, input) {
      const plan = n.plans.get(input.plan);
      const addon = n.addons.get(input.plan);
      const target: NormalizedPlan | NormalizedAddon | undefined = plan ?? addon;
      if (!target) throw new EntitlementsValidationError(`Unknown plan "${input.plan}"`);
      const candidates = input.provider
        ? [providerOrThrow(input.provider)]
        : [...providers.values()];
      const p = candidates.find((c) => c.createCheckout && target.providers[c.id]?.length);
      if (!p) {
        throw new EntitlementsValidationError(
          input.provider
            ? `Billing provider "${input.provider}" cannot sell "${input.plan}" (no checkout or no ${input.provider} id in the catalog)`
            : `No billing provider can sell "${input.plan}" (map it in the catalog's providers)`,
        );
      }
      const state = await engine.getCustomer(customer);
      return p.createCheckout!({
        customer,
        item: target.providers[p.id]![0]!,
        ...(state?.providers[p.id] ? { providerCustomer: state.providers[p.id] } : {}),
        ...(state?.email ? { email: state.email } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.successUrl !== undefined ? { successUrl: input.successUrl } : {}),
        ...(input.cancelUrl !== undefined ? { cancelUrl: input.cancelUrl } : {}),
        ...(plan?.trialDays && !hasTrialed(state, plan.key) ? { trialDays: plan.trialDays } : {}),
      });
    },

    async createPortalSession(customer, input = {}) {
      const state = await engine.getCustomer(customer);
      const candidates = input.provider
        ? [providerOrThrow(input.provider)]
        : [...providers.values()];
      const p = candidates.find((c) => c.createPortalSession && state?.providers[c.id]);
      if (!p) {
        throw new NotFoundError(
          `Customer "${customer}" has no billing account${input.provider ? ` with ${input.provider}` : ""} that offers a portal`,
        );
      }
      return p.createPortalSession!({
        customer,
        providerCustomer: state!.providers[p.id]!,
        ...(input.returnUrl !== undefined ? { returnUrl: input.returnUrl } : {}),
      });
    },

    canCheckout: [...providers.values()].some((p) => typeof p.createCheckout === "function"),
    canManage: [...providers.values()].some((p) => typeof p.createPortalSession === "function"),
  };
  return billing;
}

const hasTrialed = (state: CustomerState | null, plan: string): boolean => !!state?.trials[plan];
