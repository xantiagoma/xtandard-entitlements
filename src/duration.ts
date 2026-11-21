/**
 * Duration parsing for config values (`5000`, `"30s"`, `"5m"`, `"2h"`, `"14d"`).
 * Zero dependencies; shared by the engine (cache TTL, reservation TTL), the
 * buffered counter store (flush interval) and portal tokens (expiry).
 *
 * @module
 */

/** A duration: milliseconds, or a number with a unit (`ms`, `s`, `m`, `h`, `d`, `w`). */
export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d" | "w"}`;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/;

/**
 * Convert a {@link Duration} to milliseconds. Throws on malformed strings or
 * negative numbers.
 *
 * @example
 * ```ts
 * durationToMs("5m"); // 300000
 * durationToMs(250); // 250
 * ```
 */
export function durationToMs(duration: Duration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0)
      throw new Error(`Invalid duration: ${duration}`);
    return duration;
  }
  const match = DURATION_RE.exec(String(duration).trim());
  if (!match) throw new Error(`Invalid duration: "${duration}" (expected e.g. "30s", "5m", "14d")`);
  return Number(match[1]) * (UNIT_MS[match[2] as string] as number);
}
