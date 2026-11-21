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

import * as kit from "@xtandard/kit/hooks/log";
import type { AfterEvent, BeforeEvent, EntitlementsHooks } from "./contract.ts";

/**
 * Options for {@link createLogHook}: `log` (default `console.log`),
 * `includeBefore` (default `false`), `json` (one `{ source, phase, ...event }`
 * object per line) and `format`. The default text line is
 * `[@xtandard/entitlements] <phase> <type> <customer>` + the JSON payload.
 */
export type LogHookOptions = Omit<
  kit.LogHookOptions<BeforeEvent, AfterEvent>,
  "source" | "describe"
>;

/**
 * Build a hook that logs each control-plane event. Never throws from `before`,
 * so it never denies a mutation — it is a pure observer.
 */
export function createLogHook(options: LogHookOptions = {}): EntitlementsHooks {
  return kit.createLogHook<BeforeEvent, AfterEvent>({
    ...options,
    source: "@xtandard/entitlements",
    describe: (event) => event.customer,
  });
}
