/**
 * Time-sortable ids with a type prefix (`sub_`, `grt_`, `ovr_`, `rsv_`, `act_`):
 * 10 chars of millisecond timestamp + 12 random chars, Crockford base32.
 *
 * The generator is `createIdGenerator({ format: "ulid-lower22" })` from
 * `@xtandard/kit/util/core`: the persisted format is unchanged, and ids are now
 * monotonic within one millisecond.
 *
 * @module
 */

import { createIdGenerator } from "@xtandard/kit/util/core";

const ids = createIdGenerator({ format: "ulid-lower22" });

/**
 * A new id: `prefix` + `_` + 22 lowercase base32 chars (sorts by creation time).
 * `now` (unix ms) defaults to `Date.now()`; ids minted in the same millisecond
 * (or under a clock that went backwards) still sort in creation order.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  return ids.newId(prefix, now);
}
