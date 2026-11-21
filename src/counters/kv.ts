/**
 * Counters on top of any state storage that implements `compareAndSwap`
 * (ADR 0004): each `add` is a CAS retry loop, so it is atomic wherever the
 * storage's CAS is. Refuses to construct without CAS — a plain KV store cannot
 * count safely across concurrent writers.
 *
 * @module
 */

import { isCompareAndSwap, type EntitlementsStorage } from "../storage/contract.ts";
import { assertAmount, computeApplied, type CounterStore } from "./contract.ts";

/** Options for {@link createKvCounterStore}. */
export interface KvCounterStoreOptions {
  /** Key prefix inside the storage. Default `"counters/"`. */
  prefix?: string;
  /** CAS attempts before giving up. Default `100`. */
  maxRetries?: number;
  /** Injectable clock. Default `Date.now`. */
  now?: () => number;
}

interface Cell {
  v: number;
  exp?: number;
}

/**
 * Create a {@link CounterStore} over a compare-and-swap capable storage.
 *
 * @example
 * ```ts
 * import { createKvCounterStore } from "@xtandard/entitlements/counters/kv";
 * const counters = createKvCounterStore(redisStorage);
 * ```
 */
export function createKvCounterStore(
  storage: EntitlementsStorage,
  options: KvCounterStoreOptions = {},
): CounterStore {
  if (!isCompareAndSwap(storage)) {
    throw new Error(
      "@xtandard/entitlements: createKvCounterStore needs a storage with compareAndSwap (atomic counting is impossible without it).",
    );
  }
  const cas = storage;
  const prefix = options.prefix ?? "counters/";
  const claimPrefix = `${prefix}_claims/`;
  const maxRetries = options.maxRetries ?? 100;
  const now = options.now ?? Date.now;
  const live = (cell: Cell | null): number =>
    cell && (cell.exp === undefined || cell.exp > now()) ? cell.v : 0;

  return {
    async get(keys) {
      return Promise.all(keys.map(async (k) => live(await cas.getItem<Cell>(prefix + k))));
    },
    async add(key, amount, opts = {}) {
      assertAmount(amount);
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const cell = await cas.getItem<Cell>(prefix + key);
        const current = live(cell);
        const applied = computeApplied(current, amount, opts);
        if (applied === 0 && cell) return { applied: 0, value: current };
        const next: Cell = { v: current + applied };
        const exp = opts.expiresAt ?? cell?.exp;
        if (exp !== undefined) next.exp = exp;
        if (await cas.compareAndSwap({ key: prefix + key, expected: cell, next })) {
          return { applied, value: next.v };
        }
      }
      throw new Error(
        `@xtandard/entitlements: counter "${key}" is too contended (CAS retries exhausted)`,
      );
    },
    async set(key, value, opts = {}) {
      const cell: Cell = { v: value };
      if (opts.expiresAt !== undefined) cell.exp = opts.expiresAt;
      await cas.setItem(prefix + key, cell);
    },
    async claim(key, ttlMs) {
      const k = claimPrefix + key;
      const existing = await cas.getItem<{ exp: number }>(k);
      if (existing && existing.exp > now()) return false;
      return cas.compareAndSwap({ key: k, expected: existing, next: { exp: now() + ttlMs } });
    },
    async release(key) {
      await cas.removeItem(claimPrefix + key);
    },
    async delete(keys) {
      await Promise.all(keys.map((k) => cas.removeItem(prefix + k)));
    },
    async keys(p) {
      const all = await cas.getKeys(prefix + p);
      return all.filter((k) => !k.startsWith(claimPrefix)).map((k) => k.slice(prefix.length));
    },
  };
}
