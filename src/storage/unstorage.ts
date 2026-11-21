/**
 * Adapter that wraps an [unstorage](https://unstorage.unjs.io) `Storage`
 * instance as an {@link EntitlementsStorage}. The caller constructs and
 * configures their own unstorage instance (with whatever driver they like) and
 * passes it in — we never import `unstorage` at runtime, only its type.
 * `unstorage` therefore remains an optional peer dependency.
 *
 * unstorage normalizes keys internally: `/` and `\` become `:`, anything after
 * `?` is dropped and keys ending in `$` are hidden. So this adapter
 * percent-encodes `%`, `:`, `\`, `?` and `$` in every key, converts the
 * `:`-separated keys `getKeys` returns back to `/`, and decodes them — callers
 * always see exactly the keys they wrote. Because unstorage matches whole
 * segments only, `getKeys(prefix)` lists the prefix's parent segment and
 * filters by the full prefix.
 *
 * No `compareAndSwap`: unstorage drivers share no atomic primitive. The engine
 * then serializes customer writes with an in-process mutex, and counters need a
 * real counter driver (not `counters/kv`).
 *
 * @module
 */

import type { Storage } from "unstorage";
import type { EntitlementsStorage } from "./contract.ts";

/** Options for {@link createUnstorageStorage}. */
export interface UnstorageStorageOptions {
  /** A pre-constructed unstorage `Storage` instance (any driver). */
  storage: Storage;
}

/** Characters unstorage would rewrite or drop. */
const UNSAFE = /[%:\\?$]/g;

/** Encode a caller key so unstorage stores it verbatim (`/` stays the separator). */
const toUnstorageKey = (key: string): string =>
  key.replace(UNSAFE, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

/** Convert an unstorage `:`-separated key back to the caller's `/`-separated form. */
const fromUnstorageKey = (key: string): string =>
  key
    .replace(/:/g, "/")
    .replace(/%(25|3A|5C|3F|24)/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );

/**
 * Create an {@link EntitlementsStorage} backed by an unstorage `Storage`
 * instance. unstorage auto-serializes/deserializes JSON values, so values
 * round-trip structurally; missing keys read back as `null`.
 *
 * @example
 * ```ts
 * import { createUnstorageStorage } from "@xtandard/entitlements/storage/unstorage";
 * import { createStorage } from "unstorage";
 * import fsDriver from "unstorage/drivers/fs";
 *
 * const storage = createUnstorageStorage({
 *   storage: createStorage({ driver: fsDriver({ base: "./data/entitlements" }) }),
 * });
 * ```
 */
export function createUnstorageStorage(options: UnstorageStorageOptions): EntitlementsStorage {
  const { storage } = options;

  return {
    async getItem<T>(key: string): Promise<T | null> {
      const value = await storage.getItem<T>(toUnstorageKey(key));
      return value === undefined ? null : value;
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      // unstorage's setItem rejects `undefined`; the contract never stores it.
      await storage.setItem(toUnstorageKey(key), value as NonNullable<T>);
    },

    async removeItem(key: string): Promise<void> {
      await storage.removeItem(toUnstorageKey(key));
    },

    async getKeys(prefix: string): Promise<string[]> {
      // unstorage's getKeys takes a whole-segment base and returns `:`-separated
      // keys; list the parent segment, convert back and filter by the prefix.
      const base = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      const keys = await storage.getKeys(toUnstorageKey(base));
      return keys.map(fromUnstorageKey).filter((key) => key.startsWith(prefix));
    },
  } satisfies EntitlementsStorage;
}
