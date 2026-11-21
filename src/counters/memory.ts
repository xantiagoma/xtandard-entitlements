/**
 * In-memory counter store. Zero deps; atomic within one process (every
 * operation is a synchronous critical section). For tests, development and
 * single-instance apps — use Redis or a database across instances.
 *
 * @module
 */

import { assertAmount, computeApplied, type CounterStore } from "./contract.ts";

/** Options for {@link createMemoryCounterStore}. */
export interface MemoryCounterStoreOptions {
  /** Injectable clock (unix ms) for claim TTLs and expiry hints. Default `Date.now`. */
  now?: () => number;
  /** Seed values. */
  initial?: Record<string, number>;
}

/**
 * Create an in-memory {@link CounterStore}.
 *
 * @example
 * ```ts
 * import { createMemoryCounterStore } from "@xtandard/entitlements/counters/memory";
 * const counters = createMemoryCounterStore();
 * ```
 */
export function createMemoryCounterStore(options: MemoryCounterStoreOptions = {}): CounterStore {
  const now = options.now ?? Date.now;
  const values = new Map<string, { value: number; expiresAt?: number }>(
    Object.entries(options.initial ?? {}).map(([k, v]) => [k, { value: v }]),
  );
  const claims = new Map<string, number>();
  const read = (key: string): number => {
    const entry = values.get(key);
    if (!entry) return 0;
    if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
      values.delete(key);
      return 0;
    }
    return entry.value;
  };

  return {
    async get(keys) {
      return keys.map(read);
    },
    async add(key, amount, opts = {}) {
      assertAmount(amount);
      const current = read(key);
      const applied = computeApplied(current, amount, opts);
      const value = current + applied;
      if (applied !== 0 || !values.has(key)) {
        const entry: { value: number; expiresAt?: number } = { value };
        const exp = opts.expiresAt ?? values.get(key)?.expiresAt;
        if (exp !== undefined) entry.expiresAt = exp;
        values.set(key, entry);
      }
      return { applied, value };
    },
    async set(key, value, opts = {}) {
      assertAmount(value);
      const entry: { value: number; expiresAt?: number } = { value };
      if (opts.expiresAt !== undefined) entry.expiresAt = opts.expiresAt;
      values.set(key, entry);
    },
    async claim(key, ttlMs) {
      const exp = claims.get(key);
      if (exp !== undefined && exp > now()) return false;
      claims.set(key, now() + ttlMs);
      return true;
    },
    async release(key) {
      claims.delete(key);
    },
    async delete(keys) {
      for (const k of keys) values.delete(k);
    },
    async keys(prefix) {
      const out: string[] = [];
      for (const k of values.keys()) if (k.startsWith(prefix) && read(k) !== 0) out.push(k);
      return out;
    },
  };
}
