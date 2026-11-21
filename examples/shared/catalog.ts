/**
 * The pricing model every example shares — one catalog, imported by servers,
 * guards, the React app and the demos alike (`@xtandard/entitlements/catalog`
 * has zero dependencies, so this file also runs in the browser).
 *
 * - **free** — the default plan: 3 seats, 1 000 API calls / month, 100 AI credits.
 * - **pro** — v2 with a 14-day trial, overage on API calls and PDF export;
 *   **v1** is the grandfathered version (`price_pro_legacy`) with lower limits.
 * - **business** — unlimited API calls, SSO, 50 000 AI credits.
 * - **extra_seats** — a quantity add-on: +5 seats each.
 *
 * `gpt_tokens` is in no plan: it draws 0.01 AI credits per token from the
 * `ai_credits` pool (`creditCost`), so the credit balance alone decides.
 */
import { defineCatalog, feature } from "@xtandard/entitlements/catalog";

/** Stripe price ids the catalog maps (the stripe-webhooks demo sends these). */
export const PRICES = {
  pro: "price_pro_monthly",
  proLegacy: "price_pro_legacy",
  business: "price_business_monthly",
  extraSeats: "price_extra_seats",
} as const;

export const catalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat" }),
    api_calls: feature.metered({ name: "API calls", unit: "call", reset: "month" }),
    ai_credits: feature.credits({ name: "AI credits", unit: "credit", reset: "billing_period" }),
    gpt_tokens: feature.metered({
      name: "GPT tokens",
      unit: "token",
      reset: "never",
      creditCost: { ai_credits: 0.01 },
    }),
    export_pdf: feature.boolean({ name: "PDF export" }),
    sso: feature.boolean({ name: "SSO" }),
    max_upload_mb: feature.value({ name: "Max upload (MB)", default: 10 }),
  },
  plans: {
    free: {
      name: "Free",
      default: true,
      price: { amount: 0, currency: "usd", interval: "month" },
      features: { seats: 3, api_calls: 1_000, ai_credits: 100 },
    },
    pro: {
      name: "Pro",
      version: 2,
      highlight: true,
      trial: { days: 14 },
      price: { amount: 2900, currency: "usd", interval: "month" },
      providers: { stripe: [PRICES.pro] },
      features: {
        seats: 10,
        api_calls: { limit: 100_000, overage: "allow" },
        ai_credits: 5_000,
        export_pdf: true,
        max_upload_mb: 500,
      },
      previous: {
        // Grandfathered: subscribers on the legacy price keep v1's limits.
        1: {
          providers: { stripe: [PRICES.proLegacy] },
          features: { seats: 5, api_calls: 50_000, ai_credits: 1_000, export_pdf: true },
        },
      },
    },
    business: {
      name: "Business",
      price: { amount: 9900, currency: "usd", interval: "month" },
      providers: { stripe: [PRICES.business] },
      features: {
        seats: 50,
        api_calls: "unlimited",
        ai_credits: 50_000,
        export_pdf: true,
        sso: true,
        max_upload_mb: 2_000,
      },
    },
  },
  addons: {
    extra_seats: {
      name: "+5 seats",
      quantity: true,
      price: { amount: 2500, currency: "usd", interval: "month", label: "per pack" },
      providers: { stripe: [PRICES.extraSeats] },
      features: { seats: { add: 5 } },
    },
  },
});

/** The catalog's type — `FeatureKey<Catalog>`, `PlanKey<Catalog>`, … */
export type Catalog = typeof catalog;
