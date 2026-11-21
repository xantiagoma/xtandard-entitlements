// The panel as a catch-all route: /billing (admin UI), /billing/api/* (JSON API),
// /billing/#token=… (customer portal), POST /billing/webhooks/:provider (billing).
import { toNextHandler } from "@xtandard/entitlements/next";
import { billing, ready } from "../../../lib/billing.ts";

// toNextHandler takes anything with a web `fetch`; waiting for the seed is demo-only.
export const { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } = toNextHandler({
  fetch: async (request: Request) => {
    await ready;
    return billing.fetch(request);
  },
});
