/**
 * Bun adapter: `entitlementsPanel()` returns the web-standard panel handler to
 * hand to `Bun.serve({ fetch })`, and `requireEntitlement()` guards a route
 * handler (402 / 403 JSON for denials).
 *
 * Import from `@xtandard/entitlements/bun`.
 *
 * @module bun
 */

export * from "./adapters/bun.ts";
