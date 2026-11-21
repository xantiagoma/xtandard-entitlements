/** Shared helpers for the server / adapter tests. */
import { BillingVerificationError, type EntitlementsBilling } from "../src/billing/contract.ts";
import { NotFoundError } from "../src/engine.ts";
import {
  createFetchHandler,
  type CreateFetchHandlerResult,
  type EntitlementsPanelOptions,
} from "../src/server/create-fetch-handler.ts";
import { createTestEntitlements, type TestEntitlements } from "../src/testing.ts";
import { catalog, type TestCatalog } from "./fixtures.ts";

export const NOW = "2026-11-20T12:00:00.000Z";
export const PORTAL_SECRET = "portal-secret-for-tests";

/** A panel over an in-memory test engine with a controllable clock. */
export function testPanel(
  opts: Partial<EntitlementsPanelOptions<TestCatalog>> & {
    engine?: Parameters<typeof createTestEntitlements<TestCatalog>>[0];
  } = {},
): TestEntitlements<TestCatalog> & { panel: CreateFetchHandlerResult<TestCatalog> } {
  const { engine: engineOptions, ...panelOptions } = opts;
  const t = createTestEntitlements({ catalog, now: NOW, ...engineOptions });
  const panel = createFetchHandler<TestCatalog>({
    entitlements: t.ent,
    uiDir: "/no/such/ui",
    now: t.clock.now,
    ...panelOptions,
  });
  return { ...t, panel };
}

/** Build a JSON request. */
export const req = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

export const basic = (username: string, password: string): Record<string, string> => ({
  authorization: "Basic " + btoa(`${username}:${password}`),
});

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** Read a JSON body with a cast. */
export const body = async <T = Record<string, unknown>>(res: Response): Promise<T> =>
  (await res.json()) as T;

/** Calls recorded by {@link fakeBilling}. */
export interface FakeBillingCalls {
  webhooks: Array<{ provider: string; body: string }>;
  reconcile: Array<{ customer: string; provider?: string }>;
  checkout: Array<{ customer: string; input: unknown }>;
  portal: Array<{ customer: string; input: unknown }>;
}

/**
 * A fake {@link EntitlementsBilling}: provider `stripe`; webhooks need the
 * header `x-signature: ok`, unknown providers are 404.
 */
export function fakeBilling(
  options: { canCheckout?: boolean; canManage?: boolean } = {},
): EntitlementsBilling & { calls: FakeBillingCalls } {
  const calls: FakeBillingCalls = { webhooks: [], reconcile: [], checkout: [], portal: [] };
  return {
    calls,
    providers: ["stripe"],
    canCheckout: options.canCheckout ?? true,
    canManage: options.canManage ?? true,
    async handleWebhook(provider, request) {
      if (provider !== "stripe") throw new NotFoundError(`Unknown billing provider "${provider}"`);
      if (request.headers.get("x-signature") !== "ok") {
        throw new BillingVerificationError("Invalid signature");
      }
      calls.webhooks.push({ provider, body: await request.text() });
      return { outcome: "applied", events: 1 };
    },
    async apply() {
      return "applied";
    },
    async reconcile(customer, provider) {
      calls.reconcile.push({ customer, ...(provider ? { provider } : {}) });
      return [{ customer, provider: provider ?? "stripe", upserted: 1, canceled: 0 }];
    },
    async createCheckout(customer, input) {
      calls.checkout.push({ customer, input });
      return { url: `https://pay.example.com/${customer}/${input.plan}` };
    },
    async createPortalSession(customer, input) {
      calls.portal.push({ customer, input });
      return { url: `https://billing.example.com/${customer}` };
    },
  };
}
