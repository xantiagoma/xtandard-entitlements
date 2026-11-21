/**
 * Bring-your-own authorization: `delegatedAuthorization()` wraps a plain
 * `authorize({ principal, action, resource })` decision function (ABAC, OPA,
 * Cedar, per-customer ownership).
 *
 * Import from `@xtandard/entitlements/authorization/delegated`.
 *
 * @module authorization/delegated
 */

export * from "./authorization/delegated.ts";
