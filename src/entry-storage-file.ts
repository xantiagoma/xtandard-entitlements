/**
 * File-system state storage: one JSON file per key under a base directory,
 * write-then-rename, `fs.watch` change events, in-process compare-and-swap.
 *
 * Import from `@xtandard/entitlements/storage/file`.
 *
 * @module storage/file
 */

export { clearFileStorage, createFileStorage } from "./storage/file.ts";
export type { FileEntitlementsStorage, FileStorageOptions } from "./storage/file.ts";
