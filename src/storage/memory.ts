/**
 * In-memory storage adapter. Zero deps. Useful for tests, dev, and as the
 * default `runtimeStorage` fallback. Values are deep-cloned on write and read so
 * callers cannot mutate stored state by reference.
 *
 * @module
 */

import type {
  CompareAndSwapEntitlementsStorage,
  EntitlementsStorage,
  StorageChangeEvent,
  WatchableEntitlementsStorage,
} from "./contract.ts";

/** Options for {@link createMemoryStorage}. */
export interface MemoryStorageOptions {
  /** Optional seed data (key → value). */
  initial?: Record<string, unknown>;
}

/** Structural equality for JSON-shaped values (compare-and-swap). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** The memory storage: watchable and compare-and-swap capable. */
export type MemoryEntitlementsStorage = WatchableEntitlementsStorage &
  CompareAndSwapEntitlementsStorage;

const clone = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));

/**
 * Create an in-memory {@link EntitlementsStorage}. Also implements `watch`
 * (callbacks fire on the next microtask after a write/remove) and
 * `compareAndSwap` (deep equality; race-free in-process).
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
  const map = new Map<string, unknown>();
  if (options.initial) {
    for (const [k, val] of Object.entries(options.initial)) map.set(k, clone(val));
  }

  const watchers = new Set<{ prefix: string; cb: (event: StorageChangeEvent) => void }>();
  const notify = (event: StorageChangeEvent) => {
    for (const w of watchers) {
      if (event.key.startsWith(w.prefix)) queueMicrotask(() => w.cb(event));
    }
  };

  return {
    async getItem<T>(key: string): Promise<T | null> {
      return map.has(key) ? clone(map.get(key) as T) : null;
    },
    async setItem<T>(key: string, value: T): Promise<void> {
      map.set(key, clone(value));
      notify({ type: "update", key });
    },
    async removeItem(key: string): Promise<void> {
      if (map.delete(key)) notify({ type: "remove", key });
    },
    async getKeys(prefix: string): Promise<string[]> {
      const out: string[] = [];
      for (const k of map.keys()) if (k.startsWith(prefix)) out.push(k);
      return out;
    },
    async watch(prefix, cb): Promise<() => void> {
      const entry = { prefix, cb };
      watchers.add(entry);
      return () => {
        watchers.delete(entry);
      };
    },
    async compareAndSwap<T>(input: { key: string; expected: T | null; next: T }): Promise<boolean> {
      const current = map.has(input.key) ? map.get(input.key) : null;
      if (!deepEqual(current, input.expected)) return false;
      map.set(input.key, clone(input.next));
      notify({ type: "update", key: input.key });
      return true;
    },
  } satisfies EntitlementsStorage & MemoryEntitlementsStorage;
}
