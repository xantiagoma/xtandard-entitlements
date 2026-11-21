/**
 * `@xtandard/entitlements/hooks/log` — a reference hook that logs control-plane
 * events (plan changes, grants, overrides, usage corrections, customer edits).
 *
 * The simplest possible consumer of the hooks seam: useful as a starting point
 * for your own `after` side effects, and handy for local debugging or piping
 * admin activity to a log aggregator (`json: true` prints one JSON object per
 * line). Zero dependencies.
 *
 * @example
 * ```ts
 * import { createEntitlements } from "@xtandard/entitlements";
 * import { createLogHook } from "@xtandard/entitlements/hooks/log";
 *
 * createEntitlements({ catalog, hooks: createLogHook({ json: true }) });
 * ```
 *
 * @module
 */

import type { AfterEvent, BeforeEvent, EntitlementsHooks } from "./contract.ts";

/** Options for {@link createLogHook}. */
export interface LogHookOptions {
  /** Sink for each formatted line. Default: `console.log`. */
  log?: (line: string) => void;
  /** Also log `before` events (default `false` — `after` only). */
  includeBefore?: boolean;
  /**
   * Emit one JSON object per line (`{ "source", "phase", ...event }`) — for log
   * aggregators. Ignored when `format` is given. Default `false`.
   */
  json?: boolean;
  /**
   * Format a line for an event. Default: a compact
   * `[@xtandard/entitlements] <phase> <type> <customer>` prefix + JSON payload.
   */
  format?: (phase: "before" | "after", event: BeforeEvent | AfterEvent) => string;
}

const SOURCE = "@xtandard/entitlements";

const textFormat = (phase: "before" | "after", event: BeforeEvent | AfterEvent): string =>
  `[${SOURCE}] ${phase} ${event.type} ${event.customer} ${JSON.stringify(event)}`;

const jsonFormat = (phase: "before" | "after", event: BeforeEvent | AfterEvent): string =>
  JSON.stringify({ source: SOURCE, phase, ...event });

/**
 * Build a hook that logs each control-plane event. Never throws from `before`,
 * so it never denies a mutation — it is a pure observer.
 */
export function createLogHook(options: LogHookOptions = {}): EntitlementsHooks {
  const log = options.log ?? ((line: string) => console.log(line));
  const format = options.format ?? (options.json ? jsonFormat : textFormat);
  const hook: EntitlementsHooks = {
    after(event) {
      log(format("after", event));
    },
  };
  if (options.includeBefore) {
    hook.before = (event) => {
      log(format("before", event));
    };
  }
  return hook;
}
