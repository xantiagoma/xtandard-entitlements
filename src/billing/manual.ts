/**
 * The `manual` billing provider: a no-op adapter for subscriptions set by
 * hand — the admin UI, `ent.subscribe()`, comps and invoiced enterprise deals
 * (ADR 0007). It receives no webhooks and links out nowhere; listing it in
 * `createBilling({ providers })` just makes `"manual"` a known provider id
 * (e.g. for `billing.apply("manual", events)` from a custom back office).
 *
 * @example
 * ```ts
 * import { createBilling } from "@xtandard/entitlements/billing";
 * import { createManualProvider } from "@xtandard/entitlements/billing/manual";
 *
 * const billing = createBilling(ent, { providers: [createManualProvider()] });
 * ```
 *
 * @module billing/manual
 */

import type { BillingProvider } from "./contract.ts";

/** Create the no-op `manual` provider (`id: "manual"`). */
export function createManualProvider(): BillingProvider {
  return { id: "manual" };
}
