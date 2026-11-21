/**
 * The example catalog the standalone image serves when `CATALOG_PATH` is unset.
 * Copy it as a starting point: features, plans (with a grandfathered version),
 * an add-on, a trial.
 */
import { defineCatalog, feature } from "../../../src/catalog.ts";

export const catalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat" }),
    api_calls: feature.metered({ name: "API calls", unit: "call", reset: "month" }),
    ai_credits: feature.credits({ name: "AI credits", unit: "credit", reset: "billing_period" }),
    export_pdf: feature.boolean({ name: "PDF export" }),
    sso: feature.boolean({ name: "SSO" }),
    max_upload_mb: feature.value({ name: "Max upload (MB)", default: 10 }),
  },
  plans: {
    free: {
      name: "Free",
      default: true,
      price: { amount: 0, currency: "usd", interval: "month" },
      features: { seats: 3, api_calls: 1_000 },
    },
    pro: {
      name: "Pro",
      version: 2,
      trial: { days: 14 },
      highlight: true,
      price: { amount: 2900, currency: "usd", interval: "month" },
      features: {
        seats: 10,
        api_calls: { limit: 100_000, overage: "allow" },
        ai_credits: 5_000,
        export_pdf: true,
        max_upload_mb: 500,
      },
      previous: { 1: { features: { seats: 5, api_calls: 50_000, export_pdf: true } } },
    },
    business: {
      name: "Business",
      price: { amount: 9900, currency: "usd", interval: "month" },
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
      price: { amount: 2500, currency: "usd", interval: "month" },
      features: { seats: { add: 5 } },
    },
  },
});
