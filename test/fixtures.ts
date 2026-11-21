import { defineCatalog, feature } from "../src/catalog.ts";

/** A realistic SaaS catalog used across tests. */
export const catalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat" }),
    projects: feature.capacity({ name: "Projects", unit: "project" }),
    api_calls: feature.metered({ name: "API calls", unit: "call", reset: "month" }),
    exports: feature.metered({ name: "Exports", unit: "export", reset: "day" }),
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
    support: feature.value({ name: "Support", default: "community" }),
  },
  plans: {
    free: {
      name: "Free",
      default: true,
      price: { amount: 0, currency: "usd", interval: "month" },
      features: { seats: 3, projects: 1, api_calls: 1_000, exports: 5 },
    },
    pro: {
      name: "Pro",
      version: 2,
      trial: { days: 14 },
      highlight: true,
      price: { amount: 2900, currency: "usd", interval: "month" },
      providers: { stripe: ["price_pro_m"], polar: ["prod_pro"] },
      features: {
        seats: 10,
        projects: "unlimited",
        api_calls: { limit: 100_000, overage: "allow" },
        exports: 100,
        ai_credits: 5_000,
        export_pdf: true,
        max_upload_mb: 500,
        support: "email",
      },
      previous: {
        1: {
          providers: { stripe: ["price_pro_legacy"] },
          features: {
            seats: 5,
            projects: 10,
            api_calls: 50_000,
            exports: 50,
            export_pdf: true,
            max_upload_mb: 100,
          },
        },
      },
    },
    business: {
      name: "Business",
      price: { amount: 9900, currency: "usd", interval: "month" },
      providers: { stripe: ["price_biz_m"] },
      features: {
        seats: 50,
        projects: "unlimited",
        api_calls: { limit: 1_000_000, overage: "allow", overageLimit: 500_000 },
        exports: "unlimited",
        ai_credits: 50_000,
        export_pdf: true,
        sso: true,
        max_upload_mb: 2_000,
        support: "priority",
      },
    },
    enterprise: {
      name: "Enterprise",
      hidden: true,
      features: {
        seats: "unlimited",
        api_calls: "unlimited",
        export_pdf: true,
        sso: true,
        support: "dedicated",
      },
    },
  },
  addons: {
    extra_seats: {
      name: "+5 seats",
      quantity: true,
      price: { amount: 2500, currency: "usd", interval: "month" },
      providers: { stripe: ["price_seats"] },
      features: { seats: { add: 5 } },
    },
    sso_addon: {
      name: "SSO add-on",
      requires: ["pro"],
      price: { amount: 5000, currency: "usd", interval: "month" },
      features: { sso: true },
    },
  },
});

export type TestCatalog = typeof catalog;
