/**
 * Write-behind counters (ADR 0006). Wraps any {@link CounterStore}: `add` is
 * decided **locally** against the last known value plus pending local deltas,
 * and deltas are flushed to the inner store in batches (one unbounded `add`
 * per key) on an interval, when `maxPending` keys are dirty, and on `close()`.
 *
 * Trade-off: across N instances a limit can be overshot by up to the deltas
 * each instance has not flushed yet. Use it for high-volume, soft meters — never
 * for seats or prepaid credits. `claim`, `release`, `set` and `delete` pass
 * straight through.
 *
 * @module
 */

import { durationToMs, type Duration } from "../duration.ts";
import { assertAmount, computeApplied, type CounterStore } from "./contract.ts";

/** Options for {@link createBufferedCounterStore}. */
export interface BufferedCounterStoreOptions {
  /** Flush interval. Default `"1s"`. `0` disables the timer (flush manually / on size). */
  flushInterval?: Duration;
  /** Flush as soon as this many keys have pending deltas. Default `1000`. */
  maxPending?: number;
  /** Re-read a key from the inner store when its cached value is older than this. Default `"5s"`. */
  refreshAfter?: Duration;
  /** Called when a flush fails (the delta is kept and retried). Default `console.warn`. */
  onError?: (error: unknown) => void;
  /** Injectable clock. Default `Date.now`. */
  now?: () => number;
  /** `close()` also closes the inner store. Default `true`. */
  closeInner?: boolean;
}

/** A buffered counter store: a {@link CounterStore} plus explicit `flush`. */
export interface BufferedCounterStore extends CounterStore {
  /** Marker for the engine (decisions report `buffered: true`). */
  readonly buffered: true;
  /** Send pending deltas to the inner store. */
  flush(): Promise<void>;
  /** Number of keys with unflushed deltas. */
  pendingKeys(): number;
  /** Flush and stop the timer. */
  close(): Promise<void>;
}

interface Entry {
  base: number;
  pending: number;
  loadedAt: number;
  expiresAt?: number;
}

/**
 * Wrap `inner` with write-behind buffering.
 *
 * @example
 * ```ts
 * import { createBufferedCounterStore } from "@xtandard/entitlements/counters/buffered";
 * import { createRedisCounterStore } from "@xtandard/entitlements/counters/redis";
 *
 * const strict = createRedisCounterStore({ url: process.env.REDIS_URL });
 * const buffered = createBufferedCounterStore(strict, { flushInterval: "2s" });
 * ```
 */
export function createBufferedCounterStore(
  inner: CounterStore,
  options: BufferedCounterStoreOptions = {},
): BufferedCounterStore {
  const now = options.now ?? Date.now;
  const maxPending = options.maxPending ?? 1000;
  const refreshAfter = durationToMs(options.refreshAfter ?? "5s");
  const onError =
    options.onError ??
    ((error: unknown) =>
      console.warn("[@xtandard/entitlements] buffered counter flush failed:", error));
  const entries = new Map<string, Entry>();
  const loading = new Map<string, Promise<Entry>>();
  let dirty = 0;
  let flushing: Promise<void> | null = null;

  const load = (key: string): Promise<Entry> => {
    const cached = entries.get(key);
    if (cached && (cached.pending !== 0 || now() - cached.loadedAt < refreshAfter)) {
      return Promise.resolve(cached);
    }
    const inflight = loading.get(key);
    if (inflight) return inflight;
    const p = inner
      .get([key])
      .then(([value]) => {
        const current = entries.get(key);
        const entry: Entry = { base: value ?? 0, pending: current?.pending ?? 0, loadedAt: now() };
        if (current?.expiresAt !== undefined) entry.expiresAt = current.expiresAt;
        entries.set(key, entry);
        return entry;
      })
      .finally(() => loading.delete(key));
    loading.set(key, p);
    return p;
  };

  const doFlush = async (): Promise<void> => {
    const batch: [string, Entry, number][] = [];
    for (const [key, entry] of entries) {
      if (entry.pending !== 0) {
        batch.push([key, entry, entry.pending]);
        entry.pending = 0;
      }
    }
    dirty = 0;
    await Promise.all(
      batch.map(async ([key, entry, delta]) => {
        try {
          const opts = entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {};
          const result = await inner.add(key, delta, opts);
          entry.base = result.value;
          entry.loadedAt = now();
        } catch (error) {
          entry.pending += delta;
          dirty++;
          onError(error);
        }
      }),
    );
  };

  const flush = (): Promise<void> => {
    // Serialize flushes; a flush requested mid-flight runs right after.
    const run = (flushing ?? Promise.resolve()).then(doFlush);
    flushing = run.finally(() => {
      if (flushing === run) flushing = null;
    });
    return run;
  };

  const interval = durationToMs(options.flushInterval ?? "1s");
  const timer =
    interval > 0
      ? setInterval(() => {
          if (dirty > 0) void flush();
        }, interval)
      : undefined;
  (timer as { unref?: () => void } | undefined)?.unref?.();

  return {
    buffered: true,
    async get(keys) {
      return Promise.all(
        keys.map(async (k) => {
          const e = await load(k);
          return e.base + e.pending;
        }),
      );
    },
    async add(key, amount, opts = {}) {
      assertAmount(amount);
      const entry = await load(key);
      const current = entry.base + entry.pending;
      const applied = computeApplied(current, amount, opts);
      if (applied !== 0) {
        if (entry.pending === 0) dirty++;
        entry.pending += applied;
        if (opts.expiresAt !== undefined) entry.expiresAt = opts.expiresAt;
        if (dirty >= maxPending) void flush();
      }
      return { applied, value: current + applied };
    },
    async set(key, value, opts) {
      await inner.set(key, value, opts);
      entries.set(key, { base: value, pending: 0, loadedAt: now() });
    },
    claim: (key, ttl) => inner.claim(key, ttl),
    release: (key) => inner.release(key),
    async delete(keys) {
      for (const k of keys) entries.delete(k);
      await inner.delete(keys);
    },
    ...(inner.keys
      ? {
          async keys(prefix: string) {
            const out = new Set(await inner.keys!(prefix));
            for (const [k, e] of entries) {
              if (!k.startsWith(prefix)) continue;
              if (e.base + e.pending !== 0) out.add(k);
              else out.delete(k);
            }
            return [...out];
          },
        }
      : {}),
    flush,
    pendingKeys: () => [...entries.values()].filter((e) => e.pending !== 0).length,
    async close() {
      if (timer) clearInterval(timer);
      await flush();
      if (options.closeInner !== false) await inner.close?.();
    },
  };
}

/** True when `store` is a {@link BufferedCounterStore}. */
export const isBufferedCounterStore = (store: CounterStore): store is BufferedCounterStore =>
  (store as Partial<BufferedCounterStore>).buffered === true;
