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

/** Throw from a `before` hook to deny with a status (default 403). */
export class HookDeniedError extends Error {
  /** HTTP status the API layer should respond with. Default `403`. */
  readonly status: number;
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HookDeniedError";
    this.status = options?.status ?? 403;
  }
}

/** A hook: implement either side or both. */
export interface EntitlementsHooks {
  before?(event: BeforeEvent): void | Promise<void>;
  after?(event: AfterEvent): void | Promise<void>;
}

/** Accepts a single hook, an array, or nothing. */
export type EntitlementsHooksInput = EntitlementsHooks | readonly EntitlementsHooks[] | undefined;

/** Reports an error thrown by an `after` hook. */
export type HookErrorReporter = (error: unknown, event: AfterEvent) => void;

/** Normalize the `hooks` option into a flat array (empty when unset). */
export function normalizeHooks(input: EntitlementsHooksInput): EntitlementsHooks[] {
  if (!input) return [];
  return Array.isArray(input) ? [...input] : [input as EntitlementsHooks];
}

/** Run `before` hooks sequentially; the first throw denies. */
export async function runBefore(hooks: EntitlementsHooks[], event: BeforeEvent): Promise<void> {
  for (const hook of hooks) {
    if (hook.before) await hook.before(event);
  }
}

/** Run `after` hooks concurrently; errors go to `onError`, never to the caller. */
export async function runAfter(
  hooks: EntitlementsHooks[],
  event: AfterEvent,
  onError: HookErrorReporter,
): Promise<void> {
  await Promise.all(
    hooks.map(async (hook) => {
      if (!hook.after) return;
      try {
        await hook.after(event);
      } catch (error) {
        onError(error, event);
      }
    }),
  );
}

/** Default `after`-hook error reporter: warn, never throw. */
export const defaultHookErrorReporter: HookErrorReporter = (error, event) => {
  console.warn(`[@xtandard/entitlements] after hook failed for "${event.type}":`, error);
};
