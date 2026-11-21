/**
 * Delegated {@link AuthorizationProvider}. Wraps a caller-supplied `authorize`
 * function so you can implement any policy — ABAC, an external policy engine
 * (OPA, Cedar), per-customer / per-tenant ownership checks — without implementing the
 * interface by hand.
 *
 * The wrapper normalizes a synchronous-or-asynchronous decision into the
 * `Promise<boolean>` the contract requires.
 *
 * @module
 */

import { delegatedAuthorization as kitDelegated } from "@xtandard/kit/authorization/delegated";
import type { AuthorizationProvider, AuthorizeInput } from "./contract.ts";

/** Options for {@link delegatedAuthorization}. */
export interface DelegatedAuthorizationOptions {
  /**
   * Decide whether the {@link AuthorizeInput} is permitted. Return `true` to
   * allow. May be synchronous or asynchronous.
   */
  authorize: (input: AuthorizeInput) => Promise<boolean> | boolean;
}

/**
 * Create an {@link AuthorizationProvider} from a plain decision function.
 *
 * @example
 * ```ts
 * import { delegatedAuthorization } from "@xtandard/entitlements/authorization/delegated";
 *
 * const authz = delegatedAuthorization({
 *   // Support staff may only touch the customers of their own region.
 *   authorize: ({ principal, resource }) =>
 *     !("customer" in resource) ||
 *     resource.customer === undefined ||
 *     (principal?.metadata as { customers?: string[] } | undefined)?.customers?.includes(
 *       resource.customer,
 *     ) === true,
 * });
 * ```
 */
export function delegatedAuthorization(
  options: DelegatedAuthorizationOptions,
): AuthorizationProvider {
  return kitDelegated(options);
}
