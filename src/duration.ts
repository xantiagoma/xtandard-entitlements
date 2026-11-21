/**
 * Duration parsing for config values (`5000`, `"30s"`, `"5m"`, `"2h"`, `"14d"`).
 * Zero dependencies; shared by the engine (cache TTL, reservation TTL), the
 * buffered counter store (flush interval) and portal tokens (expiry).
 *
 * Re-exported from `@xtandard/kit/util`.
 *
 * @module
 */

export { durationToMs, type Duration } from "@xtandard/kit/util";
