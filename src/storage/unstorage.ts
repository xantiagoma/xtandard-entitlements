/**
 * Adapter that wraps an [unstorage](https://unstorage.unjs.io) `Storage`
 * instance as an {@link EntitlementsStorage}. The caller constructs and
 * configures their own unstorage instance (with whatever driver they like) and
 * passes it in — we never import `unstorage` at runtime, only its type.
 * `unstorage` therefore remains an optional peer dependency.
 *
 * unstorage normalizes keys internally: `/` and `\` become `:`, anything after
 * `?` is dropped and keys ending in `$` are hidden. So this adapter
 * percent-encodes `%`, `:`, `\`, `?` and a trailing `$`, converts the
 * `:`-separated keys `getKeys` returns back to `/`, and decodes them — callers
 * always see exactly the keys they wrote. Because unstorage matches whole
 * segments only, `getKeys(prefix)` lists the prefix's parent segment and
 * filters by the full prefix.
 *
 * No `compareAndSwap`: unstorage drivers share no atomic primitive. The engine
 * then serializes customer writes with an in-process mutex, and counters need a
 * real counter driver (not `counters/kv`).
 *
 * The driver is `@xtandard/kit/storage/unstorage`. Keys written by earlier
 * releases (every `$` encoded) are still read.
 * String values are written JSON-encoded, so a stored `"123"` reads back as the
 * string `"123"`.
 *
 * @module
 */

export {
  createUnstorageStorage,
  type UnstorageStorageOptions,
} from "@xtandard/kit/storage/unstorage";
