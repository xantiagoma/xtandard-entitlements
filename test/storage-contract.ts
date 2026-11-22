/**
 * Storage conformance for the entitlements drivers: the shared
 * `@xtandard/kit/storage/testing` suite, run with the `ent` key root (the
 * entitlements key layout, `src/keys.ts`) against each wrapped driver.
 *
 * No `.test.ts` suffix: it only runs when imported by a driver's test, which
 * injects its runner (`vitest` or `bun:test`).
 *
 * @module
 */

import {
  runStorageConformance,
  type ConformanceCapabilities,
  type ConformanceTestApi,
  type MakeStorage,
  type SeedLegacy,
} from "@xtandard/kit/storage/testing";
import { ROOT } from "../src/keys.ts";

export type { MakeStorage } from "@xtandard/kit/storage/testing";

/** What a backend declares. */
export interface StorageContractOptions {
  /** The injected test API (`{ describe, test, expect }` from vitest or bun:test). */
  t: ConformanceTestApi;
  /** Every capability the driver has — `false` for what it lacks. */
  capabilities: ConformanceCapabilities;
  /** Write a non-canonical stored form directly (the kit's legacy-CAS case). */
  seedLegacy?: SeedLegacy;
  /** Per-test timeout (live backends). */
  timeout?: number;
}

/** Register the kit conformance suite for one wrapped driver. */
export function runStorageContractTests(
  name: string,
  make: MakeStorage,
  options: StorageContractOptions,
): void {
  runStorageConformance(`entitlements ${name}`, make, { ...options, keyRoot: ROOT });
}
