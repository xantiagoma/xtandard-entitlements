/**
 * Hono adapter: `entitlementsPanel()` returns a Hono sub-app serving the panel
 * (compose with `app.route(path, panel)`), and `requireEntitlement()` is a
 * guard middleware setting `c.var.entitlement`.
 *
 * Import from `@xtandard/entitlements/hono`.
 *
 * @module hono
 */

export * from "./adapters/hono.ts";
