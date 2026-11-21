/**
 * Portal data for the React hook / component tests: a real engine's
 * `entitlements()` output plus the catalog's public pricing, exactly what
 * `GET /api/portal/me` serves.
 */

import { addon, defineCatalog, feature, pricingTable } from "../src/catalog.ts";
import type { PortalData } from "../src/react/compute.ts";
import { createTestEntitlements } from "../src/testing.ts";

export const catalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat", units: "seats" }),
    api_calls: feature.metered({ name: "API calls", unit: "call", units: "calls", reset: "month" }),
    ai_credits: feature.credits({ name: "AI credits", reset: "month" }),
    export_pdf: feature.boolean({ name: "PDF export" }),
    sso: feature.boolean({ name: "SAML SSO" }),
    max_upload_mb: feature.value({ name: "Max upload (MB)", default: 10 }),
  },
  plans: {
    free: { name: "Free", default: true, features: { seats: 3, api_calls: 1_000 } },
    pro: {
      name: "Pro",
      highlight: true,
      trial: { days: 14 },
      price: { amount: 2900, currency: "usd", interval: "month" },
      features: {
        seats: 10,
        api_calls: 100_000,
        ai_credits: 5_000,
        export_pdf: true,
        max_upload_mb: 500,
      },
    },
    business: {
      name: "Business",
      price: { amount: 9900, currency: "usd", interval: "month" },
      features: {
        seats: 50,
        api_calls: { limit: 1_000_000, overage: "allow" },
        ai_credits: 25_000,
        export_pdf: true,
        sso: true,
        max_upload_mb: 2_000,
      },
    },
  },
  addons: {
    extra_seats: addon({
      name: "+5 seats",
      requires: ["pro", "business"],
      price: { amount: 1000, currency: "usd", interval: "month" },
      features: { seats: { add: 5 } },
    }),
  },
});

/** Build portal data for a customer after `setup` ran against a test engine. */
export async function portalData(
  setup: (ent: ReturnType<typeof createTestEntitlements<typeof catalog>>["ent"]) => Promise<void>,
  options: { canCheckout?: boolean; canManage?: boolean } = {},
): Promise<PortalData> {
  const { ent } = createTestEntitlements({ catalog, now: "2026-11-10T12:00:00Z" });
  await setup(ent);
  const entitlements = await ent.entitlements("org_1");
  const state = await ent.getCustomer("org_1");
  return {
    ...entitlements,
    profile: {
      id: "org_1",
      ...(state?.name ? { name: state.name } : {}),
      ...(state?.email ? { email: state.email } : {}),
    },
    pricing: pricingTable(catalog),
    canCheckout: options.canCheckout ?? true,
    canManage: options.canManage ?? false,
  };
}
