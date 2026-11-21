// Mint a short-lived portal token for the signed-in org (after YOUR auth).
import { createPortalToken } from "@xtandard/entitlements";
import { orgOf, PORTAL_SECRET } from "../../../lib/billing.ts";

export async function GET(request: Request): Promise<Response> {
  const org = await orgOf(request);
  if (!org) return Response.json({ error: "sign in first" }, { status: 401 });
  const token = await createPortalToken(PORTAL_SECRET, org, { expiresIn: "15m" });
  return Response.json({ token, url: `/billing/#token=${token}` });
}
