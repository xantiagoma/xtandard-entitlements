/**
 * The web-standard fetch handler at the heart of every framework adapter and
 * the standalone app. Composes authentication / authorization (plus portal
 * token scoping), the JSON admin + runtime + portal API, the billing webhook
 * intake, static-asset serving and the SPA fallback into a single
 * `(request: Request) => Promise<Response>`.
 *
 * @module
 */

import {
  createPanelHandler,
  intervalTask,
  resolveUiDir,
  type PanelTask,
} from "@xtandard/kit/server";
import type { AuthProvider } from "../auth/contract.ts";
import type { AuthorizationProvider } from "../authorization/contract.ts";
import type { EntitlementsBilling } from "../billing/contract.ts";
import type { AnyCatalog } from "../catalog.ts";
import type { Duration } from "../duration.ts";
import { createEntitlements, type Entitlements, type EntitlementsOptions } from "../engine.ts";
import { normalizeBasePath } from "@xtandard/kit/server";
import type { EntitlementsCorsOptions } from "./cors.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { createApiRouter, type ApiContext, type EntitlementsPortalOptions } from "./routes.ts";

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
  const uiDir = options.uiDir ?? resolveUiDir(import.meta.url);
  const openapi = () => buildOpenApiDocument({ basePath, title });

  const apiCtx: ApiContext = {
    engine: engine as unknown as Entitlements<AnyCatalog>,
    auth: options.auth ?? defaultAuth,
    authorization: options.authorization ?? defaultAuthorization,
    title,
    readonly,
    basePath,
    openapi,
    ...(options.billing ? { billing: options.billing } : {}),
    ...(options.logoUrl !== undefined ? { logoUrl: options.logoUrl } : {}),
    ...(options.portal ? { portal: options.portal } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const router = createApiRouter(apiCtx);

  const tasks: PanelTask[] = [];
  if (options.sweepInterval !== undefined) {
    tasks.push(
      intervalTask(options.sweepInterval, () => engine.sweep(), {
        onError: (err) => console.warn("[@xtandard/entitlements] reservation sweep failed:", err),
      }),
    );
  }

  const panel = createPanelHandler({
    basePath,
    title,
    ...(options.logoUrl !== undefined ? { logoUrl: options.logoUrl } : {}),
    readonly,
    globalName: "__ENTITLEMENTS_CONFIG__",
    uiDir,
    ...(options.cors ? { cors: options.cors } : {}),
    api: router.handle,
    openapi,
    tasks,
  });

  return {
    fetch: panel.fetch,
    engine,
    openapi,
    close() {
      void panel.close();
    },
  };
}
