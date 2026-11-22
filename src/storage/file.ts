/**
 * File-system storage adapter. Persists each key as a JSON file under a base
 * directory, mirroring the slash-delimited key layout (`ent/customers/…`) as a
 * tree of nested directories with a `.json` extension on the leaf. Zero
 * external dependencies — uses `node:fs/promises`, which works in both Bun and
 * Node.
 *
 * Path segments are encoded ({@link encodeSegment}) so every key maps to a
 * distinct, safe file name on any filesystem: `Acme` / `acme` / `acmé` never
 * collide on case- or normalization-insensitive macOS/Windows volumes, and a
 * key can never escape the base directory.
 *
 * Writes go to a temporary sibling file and are renamed into place, so a crash
 * never leaves a half-written JSON file. `compareAndSwap` is serialized per key
 * **within this process** (an in-process lock around read → compare → write);
 * it is not safe across several processes sharing one directory — use a
 * database driver for that.
 *
 * The driver is `@xtandard/kit/storage/file`: writes are atomic (temporary
 * file + rename), `compareAndSwap` is serialized per key within one process,
 * and empty key segments are distinct keys.
 *
 * @module
 */

import * as kit from "@xtandard/kit/storage/file";

export { clearFileStorage, decodeSegment, encodeSegment } from "@xtandard/kit/storage/file";

/** Options for {@link createFileStorage}. */
export type FileStorageOptions = kit.FileStorageOptions;

/** The file storage: watchable and (in-process) compare-and-swap capable. */
export type FileEntitlementsStorage = kit.FileKvStorage;

/**
 * Create a file-backed {@link FileEntitlementsStorage}. `watch` is implemented
 * via `fs.watch` on the base directory (recursive); it is best-effort and may
 * coalesce or miss events on platforms without recursive-watch support.
 *
 * @example
 * ```ts
 * import { createFileStorage } from "@xtandard/entitlements/storage/file";
 *
 * const storage = createFileStorage({ dir: "./data/entitlements" });
 * ```
 */
export function createFileStorage(options: FileStorageOptions): FileEntitlementsStorage {
  return kit.createFileStorage(options);
}
