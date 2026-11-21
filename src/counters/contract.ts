/**
 * The counter port (ADR 0004). Usage lives here, not in state storage: every
 * `add` is a **single atomic operation** in the backend, so concurrent
 * consumers can never push a counter past `max` (no read-then-write races).
 *
 * Implementations: memory, buffered (write-behind decorator), redis, postgres,
 * sqlite, libsql, mongodb, drizzle, and `kv` (any state storage with
 * compare-and-swap). A custom backend is ~60 lines; the repo's
 * `test/counter-contract.ts` conformance suite shows what it must guarantee.
 *
 * @module
 */

/** Options for {@link CounterStore.add}. */
export interface CounterAddOptions {
  /**
   * Upper bound. Without `partial`, the add is all-or-nothing: applied only if
   * `value + amount <= max`. With `partial`, applies as much as fits (never
   * negative).
   */
  max?: number;
  /** Lower bound for negative amounts (refunds clamp at `min`, usually 0). */
  min?: number;
  /** Apply as much of `amount` as fits under `max` instead of nothing. */
  partial?: boolean;
  /** Retention hint (unix ms) — the backend may expire the key after this. */
  expiresAt?: number;
}

/** Result of {@link CounterStore.add}. */
export interface CounterAddResult {
  /** The amount actually applied (`0` when refused). */
  applied: number;
  /** The counter value after the operation. */
  value: number;
}

/** An atomic counter backend. Missing keys read as `0`. */
export interface CounterStore {
  /** Read several counters (missing → 0), in order. */
  get(keys: readonly string[]): Promise<number[]>;
  /** Atomically add `amount` (may be negative), honoring `max` / `min`. */
  add(key: string, amount: number, options?: CounterAddOptions): Promise<CounterAddResult>;
  /** Overwrite a counter (capacity truth, admin corrections). */
  set(key: string, value: number, options?: { expiresAt?: number }): Promise<void>;
  /** Set-if-absent marker with a TTL (idempotency, once-per-period events). True if claimed. */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Drop a claim (e.g. the guarded operation was refused). */
  release(key: string): Promise<void>;
  /** Delete counters (missing keys are ignored). */
  delete(keys: readonly string[]): Promise<void>;
  /** Optional: list counter keys under a prefix (admin views, usage series). */
  keys?(prefix: string): Promise<string[]>;
  /** Optional: flush buffered writes and release resources. */
  close?(): Promise<void>;
}

/**
 * The pure decision every driver implements atomically: given the current
 * value, how much of `amount` applies under `options`. Exported so drivers
 * (and their tests) share one definition.
 */
export function computeApplied(
  current: number,
  amount: number,
  options: CounterAddOptions = {},
): number {
  let applied = amount;
  if (amount > 0 && options.max !== undefined) {
    const room = options.max - current;
    if (amount > room) applied = options.partial ? Math.max(0, room) : 0;
  }
  if (amount < 0 && options.min !== undefined) {
    const room = current - options.min; // how far we may go down
    if (-amount > room) applied = options.partial ? -Math.max(0, room) : 0;
  }
  return applied;
}

/** Throws when an amount is not a finite number. */
export function assertAmount(amount: number): void {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new TypeError(`Counter amount must be a finite number (got ${String(amount)})`);
  }
}
