/**
 * In-memory storage adapter. Zero deps. Useful for tests, dev, and as the
 * default `runtimeStorage` fallback. Values are deep-cloned on write and read so
 * callers cannot mutate stored state by reference.
 *
 * The driver is `@xtandard/kit/storage/memory`.
 *
 * @module
 */

import * as kit from "@xtandard/kit/storage/memory";

/** Options for {@link createMemoryStorage}. */
export type MemoryStorageOptions = kit.MemoryStorageOptions;

/** The memory storage: watchable and compare-and-swap capable. */
export type MemoryEntitlementsStorage = kit.MemoryKvStorage;

/**
 * Create an in-memory storage implementing both `watch` (callbacks fire on the
 * next microtask after a write/remove) and `compareAndSwap` (structural
 * equality; race-free in-process).
 *
 * @example
 * ```ts
 * import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
 *
 * const storage = createMemoryStorage();
 * // Optionally seed with pre-existing data:
 * // const storage = createMemoryStorage({ initial: { "my-key": { value: 1 } } });
 * ```
 */
export function createMemoryStorage(options: MemoryStorageOptions = {}): MemoryEntitlementsStorage {
  return kit.createMemoryStorage(options);
}
