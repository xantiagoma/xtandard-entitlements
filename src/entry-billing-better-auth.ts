/**
 * better-auth's Stripe plugin as a billing source: subscription callbacks
 * that feed entitlements plus `plans` generated from the catalog.
 *
 * @module billing/better-auth
 */
export { betterAuthStripe, toBetterAuthPlans } from "./billing/better-auth.ts";
export type {
  BetterAuthPlansOptions,
  BetterAuthStripeCallbackData,
  BetterAuthStripeOptions,
  BetterAuthStripePlan,
  BetterAuthStripeSubscription,
  BetterAuthStripeSubscriptionOptions,
} from "./billing/better-auth.ts";
