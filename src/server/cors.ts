/**
 * Framework-independent CORS for the mounted panel. When `entitlementsPanel` /
 * `createFetchHandler` is given a `cors` option, the handler answers `OPTIONS`
 * preflights itself and attaches `Access-Control-*` headers to every response —
 * so a **cross-origin embed** (portal on `app.example.com`, panel on
 * `api.example.com`) works even if the host framework's CORS middleware does not
 * wrap the mounted sub-handler.
 *
 * The CORS handling is `@xtandard/kit/server`.
 *
 * @module
 */

export type { CorsOptions as EntitlementsCorsOptions } from "@xtandard/kit/server";
