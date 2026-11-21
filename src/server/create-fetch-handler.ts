/**
 * The web-standard fetch handler at the heart of every framework adapter and
 * the standalone app. Composes authentication / authorization (plus portal
 * token scoping), the JSON admin + runtime + portal API, the billing webhook
 * intake, static-asset serving and the SPA fallback into a single
 * `(request: Request) => Promise<Response>`.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuthProvider } from "../auth/contract.ts";
import type { AuthorizationProvider } from "../authorization/contract.ts";
import type { EntitlementsBilling } from "../billing/contract.ts";
import type { AnyCatalog } from "../catalog.ts";
import { durationToMs, type Duration } from "../duration.ts";
import { createEntitlements, type Entitlements, type EntitlementsOptions } from "../engine.ts";
import { normalizeBasePath, stripBasePath } from "./base-path.ts";
import { applyCorsHeaders, preflightResponse, type EntitlementsCorsOptions } from "./cors.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { renderIndexHtml } from "./render-index-html.ts";
import { handleApiRequest, type ApiContext, type EntitlementsPortalOptions } from "./routes.ts";
import { looksLikeAsset, serveStaticAsset } from "./static-assets.ts";

/** Options for the panel handler (shared by every framework adapter). */
export interface EntitlementsPanelOptions<C extends AnyCatalog = AnyCatalog> extends Partial<
  EntitlementsOptions<C>
> {
  /**
   * The engine to serve. When omitted, one is built from the engine options
   * on this object (`catalog` is then required — `storage`, `counters`,
   * `hooks`, … as for `createEntitlements`).
   */
  entitlements?: Entitlements<C>;
  /** Mount prefix, e.g. `"/billing"`. Default `""` (root). */
  basePath?: string;
  /** Authentication provider. Default: anonymous (no auth). */
  auth?: AuthProvider;
  /** Authorization provider. Default: allow all. */
  authorization?: AuthorizationProvider;
  /**
   * Portal-token composition: requests bearing a valid `entpt_…` token act as
   * a portal principal scoped to the token's customer (ADR 0010). Mint tokens
   * server-side with `createPortalToken`.
   */
  portal?: EntitlementsPortalOptions;
  /**
   * Billing intake (`createBilling(engine, { providers })` from
   * `@xtandard/entitlements/billing`): answers `POST /webhooks/:provider`,
   * `/api/customers/:id/reconcile` and the portal checkout / manage link-outs.
   */
  billing?: EntitlementsBilling;
  /**
   * Block every control-plane mutation (423). Runtime metering keeps working.
   * Also passed to a constructed engine.
   */
  readonly?: boolean;
  /** UI title shown in the page and bootstrap config. */
  title?: string;
  /** Logo image URL shown in the navbar in place of the title wordmark. */
  logoUrl?: string;
  /** Override the directory the bundled UI is served from (defaults to `./ui` beside this module). */
  uiDir?: string;
  /**
   * Enable CORS on the handler itself — answers `OPTIONS` preflights and
   * attaches `Access-Control-*` headers to every response, so a cross-origin
   * portal embed works regardless of the host framework.
   */
  cors?: EntitlementsCorsOptions;
  /**
   * Run `engine.sweep()` (release expired reservations) on this interval. The
   * timer is `unref()`ed — it never keeps the process alive. Default: off.
   */
  sweepInterval?: Duration;
}

/** Return shape of {@link createFetchHandler}. */
export interface CreateFetchHandlerResult<C extends AnyCatalog = AnyCatalog> {
  /** Web-standard request handler. */
  fetch(request: Request): Promise<Response>;
  /** The engine (given or constructed) — use it in-process for `check` / `consume`. */
  engine: Entitlements<C>;
  /**
   * The HTTP API as an OpenAPI 3.1 document (also served at
   * `{basePath}/api/openapi.json`). Merge it into your host app's docs.
   */
  openapi(): Record<string, unknown>;
  /** Stop the sweep timer (the engine itself is the caller's to `close()`). */
  close(): void;
}

// Anonymous defaults keep embedded usage zero-config; harden via auth/authorization.
const defaultAuth: AuthProvider = { authenticate: async () => ({ id: "anonymous" }) };
const defaultAuthorization: AuthorizationProvider = { authorize: async () => true };

/** Keys of {@link EntitlementsPanelOptions} that are panel-only (not engine options). */
const PANEL_KEYS = new Set([
  "entitlements",
  "basePath",
  "auth",
  "authorization",
  "portal",
  "billing",
  "title",
  "logoUrl",
  "uiDir",
  "cors",
  "sweepInterval",
]);

/**
 * Locate the built SPA (`dist/ui`). Compiled (the npm-consumer case) this
 * module lives in `dist/` and the bundle is the sibling `./ui`; run from
 * TypeScript source (examples, `file:` links) the bundle is at
 * `<repo>/dist/ui`. Falls back to the compiled-layout path so the "build the
 * UI" hint still fires when nothing is built yet.
 */
function defaultUiDir(): string {
  try {
    const candidates = [
      new URL("./ui", import.meta.url), // compiled: dist/<chunk>.mjs → dist/ui
      new URL("../../dist/ui", import.meta.url), // source: src/server/*.ts → <repo>/dist/ui
    ].map((u) => fileURLToPath(u));
    return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  } catch {
    return "./ui";
  }
}

function buildEngine<C extends AnyCatalog>(options: EntitlementsPanelOptions<C>): Entitlements<C> {
  if (options.entitlements) return options.entitlements;
  if (!options.catalog) {
    throw new Error(
      "createFetchHandler requires either `entitlements` (an engine) or a `catalog` to build one.",
    );
  }
  const engineOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!PANEL_KEYS.has(key) && value !== undefined) engineOptions[key] = value;
  }
  return createEntitlements(engineOptions as unknown as EntitlementsOptions<C>);
}

/**
 * Build the panel fetch handler.
 *
 * @example
 * ```ts
 * import { createFetchHandler } from "@xtandard/entitlements";
 * import { catalog } from "./catalog";
 *
 * const { fetch, engine } = createFetchHandler({
 *   catalog,
 *   basePath: "/billing",
 *   title: "Acme billing",
 *   portal: { secret: process.env.PORTAL_SECRET! },
 * });
 *
 * Bun.serve({ port: 3000, fetch });
 * // Elsewhere in the app:
 * await engine.consume("org_42", "api_calls");
 * ```
 */
export function createFetchHandler<const C extends AnyCatalog = AnyCatalog>(
  options: EntitlementsPanelOptions<C>,
): CreateFetchHandlerResult<C> {
  const basePath = normalizeBasePath(options.basePath);
  const engine = buildEngine(options);
  const readonly = options.readonly ?? engine.readonly;
  const title = options.title ?? "@xtandard/entitlements";
  const uiDir = options.uiDir ?? defaultUiDir();

  const apiCtx: ApiContext = {
    engine: engine as unknown as Entitlements<AnyCatalog>,
    auth: options.auth ?? defaultAuth,
    authorization: options.authorization ?? defaultAuthorization,
    title,
    readonly,
    basePath,
    ...(options.billing ? { billing: options.billing } : {}),
    ...(options.logoUrl !== undefined ? { logoUrl: options.logoUrl } : {}),
    ...(options.portal ? { portal: options.portal } : {}),
    ...(options.now ? { now: options.now } : {}),
  };

  const openapi = () => buildOpenApiDocument({ basePath, title });
  const cors = options.cors;

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (options.sweepInterval !== undefined) {
    const every = durationToMs(options.sweepInterval);
    if (every > 0) {
      sweepTimer = setInterval(() => {
        engine.sweep().catch((err: unknown) => {
          console.warn("[@xtandard/entitlements] reservation sweep failed:", err);
        });
      }, every);
      (sweepTimer as { unref?: () => void }).unref?.();
    }
  }

  async function fetch(request: Request): Promise<Response> {
    // CORS preflight: answer OPTIONS directly so it works for any path,
    // independent of the host framework wrapping this handler.
    if (cors && request.method === "OPTIONS") return preflightResponse(request, cors);
    const response = await respond(request);
    return cors ? applyCorsHeaders(request, response, cors) : response;
  }

  async function respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = stripBasePath(url.pathname, basePath);

    // 1. JSON API, bootstrap config, healthcheck, billing intake.
    const api = await handleApiRequest(request, path, apiCtx, openapi);
    if (api) return api;

    // 2. Only GET/HEAD reach the static UI.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 3. Static asset.
    const asset = await serveStaticAsset(uiDir, path);
    if (asset) return asset;

    // 4. A path that looks like a file but was not found → 404 (don't mask with the SPA).
    if (path !== "/" && looksLikeAsset(path)) {
      return new Response("Not Found", { status: 404 });
    }

    // 5. SPA fallback (admin + portal chrome; the SPA picks by `/config` mode).
    const html = await renderIndexHtml(uiDir, {
      title,
      basePath,
      readonly,
      ...(options.logoUrl !== undefined ? { logoUrl: options.logoUrl } : {}),
    });
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return {
    fetch,
    engine,
    openapi,
    close() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = undefined;
    },
  };
}
