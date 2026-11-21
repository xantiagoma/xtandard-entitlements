/**
 * Audit bridge (ADR 0013): record every committed control-plane change —
 * subscriptions, grants, overrides, usage resets / sets, customer updates —
 * into `@xtandard/audit` (or anything with a compatible `record`).
 *
 * The `audit` parameter is structural ({@link AuditRecorderLike}); this
 * module imports nothing from `@xtandard/audit`, so installing entitlements
 * never pulls it in.
 *
 * @example
 * ```ts
 * import { createAudit } from "@xtandard/audit";
 * import { auditHooks } from "@xtandard/entitlements/bridges/audit";
 *
 * const audit = createAudit({ storage });
 * const ent = createEntitlements({ catalog, hooks: auditHooks(audit, { tenant: "acme" }) });
 * // ent.grant(…) → audit event "entitlements.grant.created"
 * ```
 *
 * @module bridges/audit
 */

import type { AfterEvent, AfterEventType, EntitlementsHooks } from "../hooks/contract.ts";
import type { Actor, JsonObject } from "../schema.ts";

/** An audit actor (structural subset of `@xtandard/audit`'s `AuditActor`). */
export interface AuditActorLike {
  id: string;
  type?: string;
  name?: string;
  email?: string;
}

/** An audit target (structural subset of `@xtandard/audit`'s `AuditTarget`). */
export interface AuditTargetLike {
  type: string;
  id: string;
  name?: string;
}

/** What the bridge passes to `audit.record` (structural subset of `@xtandard/audit`'s `RecordInput`). */
export interface AuditRecordInputLike {
  tenant?: string;
  action: string;
  occurredAt?: string;
  actor?: AuditActorLike;
  targets?: AuditTargetLike[];
  metadata?: JsonObject;
  description?: string;
}

/** Anything with an `@xtandard/audit`-compatible `record`. */
export interface AuditRecorderLike {
  record(input: AuditRecordInputLike): unknown;
}

/** Options for {@link auditHooks}. */
export interface AuditHooksOptions {
  /** Tenant for every event, or per event. Omit to use the audit log's ambient context tenant. */
  tenant?: string | ((event: AfterEvent) => string | undefined);
  /** Action prefix. Default `"entitlements."` (→ `entitlements.subscription.changed`). */
  actionPrefix?: string;
  /** Only record these event types (default: all). */
  events?: readonly AfterEventType[];
}

const actorOf = (actor: Actor | null): AuditActorLike | undefined => {
  if (!actor) return undefined;
  const out: AuditActorLike = { id: actor.id };
  if (actor.type) out.type = actor.type;
  if (actor.name) out.name = actor.name;
  if (actor.email) out.email = actor.email;
  return out;
};

const clean = (o: Record<string, unknown>): JsonObject =>
  JSON.parse(JSON.stringify(o)) as JsonObject;

/** Targets, metadata and a one-line description for an event. */
function describe(event: AfterEvent): {
  targets: AuditTargetLike[];
  metadata: JsonObject;
  description: string;
} {
  const customer: AuditTargetLike = { type: "customer", id: event.customer };
  switch (event.type) {
    case "subscription.changed": {
      const s = event.subscription;
      const p = event.previous;
      return {
        targets: [customer, { type: "subscription", id: s.id, name: s.plan }],
        metadata: clean({
          plan: s.plan,
          version: s.version,
          kind: s.kind,
          status: s.status,
          quantity: s.quantity,
          provider: s.provider,
          providerRef: s.providerRef,
          previous: p
            ? { plan: p.plan, version: p.version, status: p.status, quantity: p.quantity }
            : undefined,
        }),
        description: p
          ? `${s.plan}: ${p.plan === s.plan ? "" : `${p.plan} → `}${p.status === s.status ? s.status : `${p.status} → ${s.status}`}`
          : `${s.plan} (${s.status})`,
      };
    }
    case "subscription.removed":
      return {
        targets: [customer, { type: "subscription", id: event.subscription.id }],
        metadata: clean({ plan: event.subscription.plan, provider: event.subscription.provider }),
        description: `Removed ${event.subscription.plan} subscription`,
      };
    case "grant.created":
    case "grant.revoked": {
      const g = event.grant;
      return {
        targets: [customer, { type: "grant", id: g.id }, { type: "feature", id: g.feature }],
        metadata: clean({
          feature: g.feature,
          amount: g.amount,
          recurring: g.recurring,
          expiresAt: g.expiresAt,
          reason: g.reason,
        }),
        description: `${event.type === "grant.created" ? "Granted" : "Revoked"} ${g.amount} ${g.feature}`,
      };
    }
    case "override.created":
    case "override.removed": {
      const o = event.override;
      return {
        targets: [customer, { type: "override", id: o.id }, { type: "feature", id: o.feature }],
        metadata: clean({
          feature: o.feature,
          enabled: o.enabled,
          limit: o.limit,
          overage: o.overage,
          value: o.value,
          expiresAt: o.expiresAt,
          reason: o.reason,
        }),
        description: `${event.type === "override.created" ? "Override on" : "Removed override on"} ${o.feature}`,
      };
    }
    case "usage.reset":
      return {
        targets: [customer, { type: "feature", id: event.feature }],
        metadata: { feature: event.feature },
        description: `Reset ${event.feature} usage`,
      };
    case "usage.set":
      return {
        targets: [customer, { type: "feature", id: event.feature }],
        metadata: { feature: event.feature, value: event.value },
        description: `Set ${event.feature} usage to ${event.value}`,
      };
    case "customer.updated":
    case "customer.deleted":
      return {
        targets: [customer],
        metadata: clean({ name: event.state.name, email: event.state.email }),
        description: event.type === "customer.updated" ? "Customer updated" : "Customer deleted",
      };
  }
}

/**
 * `after` hooks that record entitlements changes as audit events
 * (`entitlements.<event type>`, the customer and the changed object as
 * targets, a compact metadata summary). Recording errors are isolated by the
 * engine's hook runner (`onHookError`).
 */
export function auditHooks(
  audit: AuditRecorderLike,
  options: AuditHooksOptions = {},
): EntitlementsHooks {
  const prefix = options.actionPrefix ?? "entitlements.";
  const only = options.events ? new Set<AfterEventType>(options.events) : undefined;
  return {
    async after(event) {
      if (only && !only.has(event.type)) return;
      const { targets, metadata, description } = describe(event);
      const input: AuditRecordInputLike = {
        action: `${prefix}${event.type}`,
        occurredAt: event.at,
        targets,
        metadata,
        description,
      };
      const tenant = typeof options.tenant === "function" ? options.tenant(event) : options.tenant;
      if (tenant) input.tenant = tenant;
      const actor = actorOf(event.actor);
      if (actor) input.actor = actor;
      await audit.record(input);
    },
  };
}
