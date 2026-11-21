/**
 * Test helper: one in-process PGlite per test file (booting the WASM Postgres
 * is the slow part) with a fresh, uniquely named table per test for isolation.
 *
 * @module
 */

import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";

// PGlite boots and runs single-threaded WASM; give loaded CI machines room.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let shared: PGlite | undefined;
let n = 0;

/** The file's shared PGlite instance (created on first use). */
export const pglite = (): PGlite => (shared ??= new PGlite());

/** A table name not used before in this process. */
export const uniqueTable = (base = "t"): string => `${base}_${n++}`;
