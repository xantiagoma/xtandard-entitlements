// Plan-gated (boolean): checked, not consumed. Free → 402 with unlockedBy ["pro", "business"].
import { withEntitlement } from "@xtandard/entitlements/next";
import { ent, orgOf } from "../../../lib/billing.ts";

export const POST = withEntitlement(
  async () => Response.json({ ok: true, url: "/exports/report.pdf" }),
  { engine: ent, feature: "export_pdf", customer: orgOf },
);
