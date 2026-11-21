// Metered: one atomic `api_calls` consume per request. Denied → 402 { reason, unlockedBy, … }.
import { withEntitlement } from "@xtandard/entitlements/next";
import { ent, orgOf } from "../../../lib/billing.ts";

export const POST = withEntitlement(
  async (_request, { entitlement }) =>
    Response.json({ ok: true, remaining: entitlement.remaining }),
  {
    engine: ent,
    feature: "api_calls",
    consume: true,
    customer: orgOf,
    idempotencyKey: (request) => request.headers.get("idempotency-key"),
  },
);
