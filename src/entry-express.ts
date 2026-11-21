/**
 * Express adapter: `entitlementsPanel()` bridges Node's `req` / `res` to the
 * web-standard panel handler (mount it before any body parser), and
 * `requireEntitlement()` is a guard middleware setting `req.entitlement`.
 *
 * Import from `@xtandard/entitlements/express`.
 *
 * @module express
 */

export * from "./adapters/express.ts";
