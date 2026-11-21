/**
 * Authorization contract. Answers: "Can this principal perform this action on
 * this resource?"
 *
 * Every admin, runtime and (admin-previewed) portal API route consults the
 * {@link AuthorizationProvider} with one {@link EntitlementsAction} and the
 * {@link EntitlementsResource} it targets (see docs/HTTP_API.md for the
 * route → action table). Portal-token principals never reach the provider:
 * they are force-scoped to their customer and to the portal actions (ADR 0010).
 * Ships `none` / `roles` / `delegated` implementations.
 *
 * @module
 */

import type { Principal } from "../auth/contract.ts";

/** The full set of authorizable actions. */
export type EntitlementsAction =
  | "catalog:read"
  | "customer:read"
  | "customer:update"
  | "customer:delete"
  | "subscription:write"
  | "grant:write"
  | "override:write"
  | "usage:read"
  | "usage:write"
  | "activity:read"
  | "runtime:check"
  | "runtime:consume"
  | "portal:read"
  | "portal:checkout"
  | "portal:manage";

/**
 * The resource an action targets. `customer` is absent on collection-level
 * routes (list customers, global activity, reservation sweep).
 */
export type EntitlementsResource =
  | { type: "catalog" }
  | { type: "customer"; customer?: string }
  | { type: "subscription"; customer?: string; id?: string; plan?: string }
  | { type: "grant"; customer: string; id?: string }
  | { type: "override"; customer: string; id?: string }
  | { type: "usage"; customer?: string; feature?: string }
  | { type: "activity"; customer?: string }
  | { type: "runtime"; customer?: string; feature?: string }
  | { type: "portal"; customer: string };

/** Input passed to {@link AuthorizationProvider.authorize}. */
export interface AuthorizeInput {
  principal: Principal | null;
  action: EntitlementsAction;
  resource: EntitlementsResource;
  request: Request;
}

/** Decides whether an action is permitted. */
export interface AuthorizationProvider {
  authorize(input: AuthorizeInput): Promise<boolean>;
}

/** Every action, in a stable order (role presets, docs, the UI). */
export const ALL_ACTIONS: readonly EntitlementsAction[] = [
  "catalog:read",
  "customer:read",
  "customer:update",
  "customer:delete",
  "subscription:write",
  "grant:write",
  "override:write",
  "usage:read",
  "usage:write",
  "activity:read",
  "runtime:check",
  "runtime:consume",
  "portal:read",
  "portal:checkout",
  "portal:manage",
];

/**
 * Control-plane actions that write state — blocked when the panel (or the
 * roles provider) is readonly. Runtime consumption (`runtime:consume`) and the
 * portal link-outs (`portal:checkout`, `portal:manage`) are not in the set:
 * readonly freezes the _control plane_, metering keeps working (engine
 * `readonly` has the same semantics).
 */
export const MUTATING_ACTIONS: ReadonlySet<EntitlementsAction> = new Set<EntitlementsAction>([
  "customer:update",
  "customer:delete",
  "subscription:write",
  "grant:write",
  "override:write",
  "usage:write",
]);

/** True if the action writes control-plane state. */
export const isMutatingAction = (action: EntitlementsAction): boolean =>
  MUTATING_ACTIONS.has(action);

/** The actions a portal-token principal may be granted (and the default scope of a token). */
export const PORTAL_ACTIONS: readonly EntitlementsAction[] = [
  "portal:read",
  "portal:checkout",
  "portal:manage",
];
