/**
 * The billing intake and port (ADR 0007): `createBilling(ent, { providers })`
 * verifies provider webhooks, maps provider items to catalog plans and
 * converges subscription state; `createUsageExporter` forwards usage to
 * provider meters. Provider adapters live at `billing/stripe`,
 * `billing/polar`, `billing/paddle`, `billing/lemonsqueezy`,
 * `billing/better-auth` and `billing/manual`.
 *
 * @module billing
 */
export { createBilling } from "./billing/intake.ts";
export type { BillingOptions, UnmappedEvent } from "./billing/intake.ts";
export { createUsageExporter } from "./billing/usage-export.ts";
export type { UsageExporter, UsageExporterOptions } from "./billing/usage-export.ts";
export { BillingApiError } from "./billing/verify.ts";
export type { FetchLike, ProviderHttpOptions } from "./billing/verify.ts";
export { BillingVerificationError } from "./billing/contract.ts";
export type {
  BillingEvent,
  BillingProvider,
  BillingWebhook,
  CheckoutInput,
  EntitlementsBilling,
  IntakeOutcome,
  PortalSessionInput,
  ProviderItem,
  ProviderSubscription,
  ReconcileResult,
  UsageRecord,
} from "./billing/contract.ts";
