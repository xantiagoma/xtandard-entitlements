/**
 * Next.js App Router adapter: `toNextHandler(panel)` → the `GET` / `POST` / …
 * exports of a catch-all route, and `withEntitlement(handler, options)` guards a
 * route handler (402 / 403 JSON for denials).
 *
 * Import from `@xtandard/entitlements/next`.
 *
 * @module next
 */

export * from "./adapters/next.ts";
