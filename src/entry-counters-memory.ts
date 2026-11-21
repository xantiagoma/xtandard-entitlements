/**
 * In-memory counter store (zero deps; atomic within one process).
 *
 * @module counters/memory
 */
export { createMemoryCounterStore } from "./counters/memory.ts";
export type { MemoryCounterStoreOptions } from "./counters/memory.ts";
