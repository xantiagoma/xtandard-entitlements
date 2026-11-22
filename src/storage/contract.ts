/**
 * Storage contracts. The base {@link EntitlementsStorage} is intentionally tiny — four
 * async methods — so users can bring their own backend. Optional capabilities
 * (watch, transactions, compare-and-swap) are separate interfaces that adapters
 * may implement and the core feature-detects.
 *
 * The neutral contract lives in `@xtandard/kit/storage`; these are the
 * entitlements names for it.
 *
 * @module
 */

import { requirePeer as kitRequirePeer } from "@xtandard/kit/storage";

export type {
  CompareAndSwapKvStorage as CompareAndSwapEntitlementsStorage,
  KvStorage as EntitlementsStorage,
  StorageChangeEvent,
  TransactionalKvStorage as TransactionalEntitlementsStorage,
  WatchableKvStorage as WatchableEntitlementsStorage,
} from "@xtandard/kit/storage";
export { isCompareAndSwap, isTransactional, isWatchable } from "@xtandard/kit/storage";

/**
 * Helper for adapters whose subpath requires an optional peer dependency. Throws
 * a clear, actionable error when the peer is missing.
 */
export function requirePeer(name: string, subpath: string): never {
  return kitRequirePeer(name, `@xtandard/entitlements/${subpath}`);
}
