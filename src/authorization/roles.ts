/**
 * Role-based {@link AuthorizationProvider}. Maps each role name to the set of
 * {@link EntitlementsAction}s it grants, then allows an action when _any_ of
 * the principal's roles grants it.
 *
 * The policy is a flat `Record<roleName, EntitlementsAction[] | "*">` — `"*"`
 * is a wildcard granting every action. When no `policy` is supplied, the
 * built-in {@link DEFAULT_ROLE_POLICY} applies:
 *
 * | Role              | Grants                                                                    |
 * | ----------------- | ------------------------------------------------------------------------- |
 * | `viewer`          | read the catalog, customers, usage and activity                           |
 * | `support`         | viewer + grants, overrides, usage corrections, customer details           |
 * | `billing-admin`   | viewer + subscriptions / trials / migrations / reconcile, grants, details |
 * | `admin`           | `"*"` — everything (incl. deleting customers, portal previews)            |
 * | `runtime-service` | `runtime:check` / `runtime:consume` + `catalog:read` (service accounts)   |
 *
 * A `readonly` switch denies every {@link isMutatingAction mutating} action
 * regardless of role — handy for read-only mirrors or "break glass" lockdowns.
 *
 * @module
 */

import {
  rolesAuthorization as kitRoles,
  type RolePolicy as KitRolePolicy,
} from "@xtandard/kit/authorization/roles";
import {
  ALL_ACTIONS,
  isMutatingAction,
  type AuthorizationProvider,
  type EntitlementsAction,
  type EntitlementsResource,
} from "./contract.ts";

export { ALL_ACTIONS };

/** Every read-only action (the `*:read` subset of {@link ALL_ACTIONS}, portal reads excluded). */
export const READ_ACTIONS: readonly EntitlementsAction[] = ALL_ACTIONS.filter(
  (a) => a.endsWith(":read") && !a.startsWith("portal:"),
);

/** A role policy: each role maps to an explicit action list or the `"*"` wildcard. */
export type RolePolicy = KitRolePolicy<EntitlementsAction>;

/** Read the catalog, customers, usage graphs and activity. */
export const VIEWER_ACTIONS: readonly EntitlementsAction[] = READ_ACTIONS;

/** Viewer + comp/raise/disable features, grant balances, correct usage, edit customer details. */
export const SUPPORT_ACTIONS: readonly EntitlementsAction[] = [
  ...READ_ACTIONS,
  "customer:update",
  "grant:write",
  "override:write",
  "usage:write",
];

/** Viewer + plan changes, trials, version migrations, reconcile, grants, customer details. */
export const BILLING_ADMIN_ACTIONS: readonly EntitlementsAction[] = [
  ...READ_ACTIONS,
  "customer:update",
  "subscription:write",
  "grant:write",
];

/** Server-to-server metering (`/api/v1/*`) for services that can't embed the library. */
export const RUNTIME_SERVICE_ACTIONS: readonly EntitlementsAction[] = [
  "catalog:read",
  "runtime:check",
  "runtime:consume",
];

/**
 * The default role policy applied when {@link RolesAuthorizationOptions.policy}
 * is omitted (see the module table).
 */
export const DEFAULT_ROLE_POLICY: RolePolicy = {
  viewer: VIEWER_ACTIONS,
  support: SUPPORT_ACTIONS,
  "billing-admin": BILLING_ADMIN_ACTIONS,
  admin: "*",
  "runtime-service": RUNTIME_SERVICE_ACTIONS,
};

/** Options for {@link rolesAuthorization}. */
export interface RolesAuthorizationOptions {
  /**
   * Role → granted actions. `"*"` grants everything. Defaults to
   * {@link DEFAULT_ROLE_POLICY} when omitted.
   */
  policy?: RolePolicy;
  /**
   * When `true`, every {@link isMutatingAction mutating} action is denied
   * regardless of the principal's roles.
   * @default false
   */
  readonly?: boolean;
}

/**
 * Create a role-based {@link AuthorizationProvider}.
 *
 * Decision order:
 * 1. If `readonly` and the action mutates → **deny**.
 * 2. If the principal is `null` → **deny**.
 * 3. If any of the principal's roles grants the action (via `"*"` or an explicit
 *    list) → **allow**; otherwise **deny**.
 *
 * @example
 * ```ts
 * import { rolesAuthorization } from "@xtandard/entitlements/authorization/roles";
 *
 * // Built-in viewer / support / billing-admin / admin / runtime-service policy:
 * const authz = rolesAuthorization();
 *
 * // Custom policy:
 * const custom = rolesAuthorization({
 *   policy: {
 *     success: ["customer:read", "usage:read", "grant:write"],
 *     auditor: ["activity:read"],
 *   },
 * });
 * ```
 */
export function rolesAuthorization(options: RolesAuthorizationOptions = {}): AuthorizationProvider {
  return kitRoles<EntitlementsAction, EntitlementsResource>({
    policy: options.policy ?? DEFAULT_ROLE_POLICY,
    actions: { isMutatingAction },
    readonly: options.readonly,
  });
}
