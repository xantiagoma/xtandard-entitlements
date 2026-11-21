/**
 * Demo customers, seeded once per engine (idempotent: a customer that already
 * exists is left alone), so every panel opens on something to look at.
 *
 * | Customer     | Plan                    | Notes                               |
 * | ------------ | ----------------------- | ----------------------------------- |
 * | `org_free`   | free (default)          | 250 API calls used                  |
 * | `org_acme`   | pro v2 + 1× extra_seats | 7 seats, 12 000 API calls used      |
 * | `org_legacy` | pro **v1**              | grandfathered on the legacy price   |
 * | `org_globex` | business                | unlimited API calls, SSO            |
 * | `org_trial`  | pro (trialing)          | a 14-day trial started today        |
 */
import type { Entitlements } from "@xtandard/entitlements";
import type { Catalog } from "./catalog.ts";

/** The customer ids {@link seedDemoCustomers} creates. */
export const DEMO_CUSTOMERS = [
  "org_free",
  "org_acme",
  "org_legacy",
  "org_globex",
  "org_trial",
] as const;

/** Seed the demo customers (skips any that already exist). */
export async function seedDemoCustomers(ent: Entitlements<Catalog>): Promise<void> {
  const fresh = async (id: string, name: string, email: string): Promise<boolean> => {
    if (await ent.getCustomer(id)) return false;
    await ent.updateCustomer(id, { name, email });
    return true;
  };

  if (await fresh("org_free", "Freebird Labs", "ops@freebird.test")) {
    await ent.setUsage("org_free", "api_calls", 250);
  }
  if (await fresh("org_acme", "Acme Inc.", "billing@acme.test")) {
    await ent.subscribe("org_acme", { plan: "pro" });
    await ent.subscribe("org_acme", { plan: "extra_seats", quantity: 1 });
    await ent.setUsage("org_acme", "seats", 7);
    await ent.setUsage("org_acme", "api_calls", 12_000);
  }
  if (await fresh("org_legacy", "Legacy Co.", "admin@legacy.test")) {
    await ent.subscribe("org_legacy", { plan: "pro", version: 1 });
  }
  if (await fresh("org_globex", "Globex Corp.", "it@globex.test")) {
    await ent.subscribe("org_globex", { plan: "business" });
  }
  if (await fresh("org_trial", "Initech", "peter@initech.test")) {
    await ent.startTrial("org_trial", "pro");
  }
}
