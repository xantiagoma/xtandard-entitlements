/**
 * Control-plane hooks fired around state mutations — plan changes, grants,
 * overrides, usage resets (mirrors the flags/webhooks hooks contract).
 *
 * - `before` runs sequentially before the write commits. **Throw to deny**
 *   (e.g. {@link HookDeniedError}); the error propagates to the caller.
 * - `after` runs once committed, for side effects (audit, webhooks, cache
 *   busting). Errors are isolated and reported via `onHookError`.
 *
 * Runtime traffic (`check` / `consume`) does not go through hooks; observe it
 * with the engine's `onUsage` / `onThreshold` taps.
 *
 * @module
 */

import {
  createHookErrorReporter,
  type HookErrorReporter as KitHookErrorReporter,
  type Hooks,
  type HooksInput,
} from "@xtandard/kit/hooks";
import type { Actor, CustomerState, Grant, Override, Subscription } from "../schema.ts";

/** Events delivered to `before` hooks (the mutation has not happened yet). */
export type BeforeEvent =
  | {
      type: "subscription.upsert";
      customer: string;
      subscription: Subscription;
      previous?: Subscription;
      actor: Actor | null;
    }
  | { type: "subscription.remove"; customer: string; subscriptionId: string; actor: Actor | null }
  | { type: "grant.create"; customer: string; grant: Grant; actor: Actor | null }
  | { type: "grant.revoke"; customer: string; grantId: string; actor: Actor | null }
  | { type: "override.create"; customer: string; override: Override; actor: Actor | null }
  | { type: "override.remove"; customer: string; overrideId: string; actor: Actor | null }
  | { type: "usage.reset"; customer: string; feature: string; actor: Actor | null }
  | { type: "usage.set"; customer: string; feature: string; value: number; actor: Actor | null }
  | { type: "customer.update"; customer: string; actor: Actor | null }
  | { type: "customer.delete"; customer: string; actor: Actor | null };

/** Events delivered to `after` hooks (committed). */
export type AfterEvent =
  | {
      type: "subscription.changed";
      customer: string;
      subscription: Subscription;
      previous?: Subscription;
      actor: Actor | null;
      at: string;
    }
  | {
      type: "subscription.removed";
      customer: string;
      subscription: Subscription;
      actor: Actor | null;
      at: string;
    }
  | { type: "grant.created"; customer: string; grant: Grant; actor: Actor | null; at: string }
  | { type: "grant.revoked"; customer: string; grant: Grant; actor: Actor | null; at: string }
  | {
      type: "override.created";
      customer: string;
      override: Override;
      actor: Actor | null;
      at: string;
    }
  | {
      type: "override.removed";
      customer: string;
      override: Override;
      actor: Actor | null;
      at: string;
    }
  | { type: "usage.reset"; customer: string; feature: string; actor: Actor | null; at: string }
  | {
      type: "usage.set";
      customer: string;
      feature: string;
      value: number;
      actor: Actor | null;
      at: string;
    }
  | {
      type: "customer.updated";
      customer: string;
      state: CustomerState;
      actor: Actor | null;
      at: string;
    }
  | {
      type: "customer.deleted";
      customer: string;
      state: CustomerState;
      actor: Actor | null;
      at: string;
    };

/** The discriminant strings of {@link BeforeEvent} / {@link AfterEvent}. */
export type BeforeEventType = BeforeEvent["type"];
export type AfterEventType = AfterEvent["type"];

export { HookDeniedError, normalizeHooks, runAfter, runBefore } from "@xtandard/kit/hooks";

/** A hook: implement either side or both. */
export type EntitlementsHooks = Hooks<BeforeEvent, AfterEvent>;

/** Accepts a single hook, an array, or nothing. */
export type EntitlementsHooksInput = HooksInput<BeforeEvent, AfterEvent>;

/** Reports an error thrown by an `after` hook. */
export type HookErrorReporter = KitHookErrorReporter<AfterEvent>;

/** Default `after`-hook error reporter: warn with the `[@xtandard/entitlements]` prefix, never throw. */
export const defaultHookErrorReporter: HookErrorReporter =
  createHookErrorReporter("@xtandard/entitlements");
