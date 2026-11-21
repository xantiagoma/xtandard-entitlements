/**
 * Write-behind counter decorator for high-volume soft meters (ADR 0006).
 *
 * @module counters/buffered
 */
export { createBufferedCounterStore, isBufferedCounterStore } from "./counters/buffered.ts";
export type { BufferedCounterStore, BufferedCounterStoreOptions } from "./counters/buffered.ts";
