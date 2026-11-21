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
 * @module
 */

import { existsSync, watch as fsWatch } from "node:fs";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type {
  CompareAndSwapEntitlementsStorage,
  StorageChangeEvent,
  WatchableEntitlementsStorage,
} from "./contract.ts";
import { deepEqual } from "./util.ts";

/** Options for {@link createFileStorage}. */
export interface FileStorageOptions {
  /** Base directory under which key files are written. Created on demand. */
  dir: string;
}

/** The file storage: watchable and (in-process) compare-and-swap capable. */
export type FileEntitlementsStorage = WatchableEntitlementsStorage &
  CompareAndSwapEntitlementsStorage;

/** Suffix appended to the leaf file for every stored key. */
const JSON_SUFFIX = ".json";

/**
 * Encode one key segment as a file name that survives case-insensitive and
 * normalization-insensitive filesystems (macOS, Windows) and never escapes its
 * directory: uppercase letters become `^` + the lowercase letter, `^` becomes
 * `^^`, bytes outside `[a-z0-9._~!@,=+-]` (UTF-8, so `é` is never folded with
 * `e` or its decomposed form) become `%XX`, a leading `.` is `%2E` (so `.` /
 * `..` / dotfiles cannot appear) and the empty segment is a lone `%`.
 * Mirrors `@xtandard/links`.
 */
export function encodeSegment(segment: string): string {
  if (segment === "") return "%";
  let out = "";
  for (const byte of new TextEncoder().encode(segment)) {
    const ch = String.fromCharCode(byte);
    if (byte >= 0x41 && byte <= 0x5a) out += `^${ch.toLowerCase()}`;
    else if (ch === "^") out += "^^";
    else if (/[a-z0-9._~!@,=+-]/.test(ch) && !(ch === "." && out === "")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Reverse {@link encodeSegment}. */
export function decodeSegment(name: string): string {
  if (name === "%") return "";
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const ch = name[i] as string;
    if (ch === "^") {
      const next = name[++i] ?? "";
      bytes.push((next === "^" ? "^" : next.toUpperCase()).charCodeAt(0));
    } else if (ch === "%") {
      bytes.push(Number.parseInt(name.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(ch.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Map a storage key (e.g. `ent/customers/org_1`) to an absolute file path
 * inside `dir`. Each (encoded) key segment becomes a directory; the last
 * segment gains a `.json` extension.
 */
function keyToPath(dir: string, key: string): string {
  return join(dir, ...key.split("/").map(encodeSegment)) + JSON_SUFFIX;
}

/**
 * Reverse {@link keyToPath}: turn an absolute (or `dir`-relative) file path back
 * into the original slash-delimited storage key. Returns `null` for paths that
 * are not `.json` leaves under `dir`.
 */
function pathToKey(dir: string, filePath: string): string | null {
  const rel = relative(dir, filePath);
  if (rel.startsWith("..") || !rel.endsWith(JSON_SUFFIX)) return null;
  return rel.slice(0, -JSON_SUFFIX.length).split(sep).map(decodeSegment).join("/");
}

/** Recursively collect every `.json` leaf file path under `root`. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = (await readdir(root, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    const name = entry.name.toString();
    const full = join(root, name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile() && name.endsWith(JSON_SUFFIX)) {
      out.push(full);
    }
  }
  return out;
}

let tmpCounter = 0;

/**
 * Create a file-backed {@link FileEntitlementsStorage}. Values are serialized as
 * pretty-printed JSON. `watch` is implemented via `fs.watch` on the base
 * directory (recursive); it is best-effort and may coalesce or miss events on
 * platforms without recursive-watch support.
 *
 * @example
 * ```ts
 * import { createFileStorage } from "@xtandard/entitlements/storage/file";
 *
 * const storage = createFileStorage({ dir: "./data/entitlements" });
 * ```
 */
export function createFileStorage(options: FileStorageOptions): FileEntitlementsStorage {
  const { dir } = options;
  /** Per-key promise chains: every write to a key runs after the previous one. */
  const locks = new Map<string, Promise<unknown>>();

  /** Run `fn` exclusively for `key` (in this process). */
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  async function read<T>(key: string): Promise<T | null> {
    try {
      const raw = await readFile(keyToPath(dir, key), "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async function write(key: string, value: unknown): Promise<void> {
    const path = keyToPath(dir, key);
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename: readers never observe a partially written file.
    const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await rename(tmp, path);
  }

  return {
    getItem: read,

    async setItem<T>(key: string, value: T): Promise<void> {
      await withLock(key, () => write(key, value));
    },

    async removeItem(key: string): Promise<void> {
      await withLock(key, async () => {
        try {
          await unlink(keyToPath(dir, key));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      });
    },

    async getKeys(prefix: string): Promise<string[]> {
      const files = await walk(dir);
      const out: string[] = [];
      for (const file of files) {
        const key = pathToKey(dir, file);
        if (key !== null && key.startsWith(prefix)) out.push(key);
      }
      return out;
    },

    async compareAndSwap<T>(input: { key: string; expected: T | null; next: T }): Promise<boolean> {
      return withLock(input.key, async () => {
        const current = await read<T>(input.key);
        if (!deepEqual(current, input.expected)) return false;
        await write(input.key, input.next);
        return true;
      });
    },

    async watch(
      prefix: string,
      callback: (event: StorageChangeEvent) => void,
    ): Promise<() => void> {
      // Ensure the watched root exists so fs.watch does not throw on a fresh dir.
      await mkdir(dir, { recursive: true });
      const watcher = fsWatch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const key = pathToKey(dir, join(dir, filename.toString()));
        if (key === null || !key.startsWith(prefix)) return;
        // `rename` covers creation, deletion and our write-then-rename, so
        // report "remove" only when the underlying file is actually gone.
        const type: StorageChangeEvent["type"] =
          eventType === "rename" && !existsSync(keyToPath(dir, key)) ? "remove" : "update";
        callback({ type, key });
      });
      return () => watcher.close();
    },
  } satisfies FileEntitlementsStorage;
}

/**
 * Delete every file written by a {@link createFileStorage} instance by removing
 * its base directory. Exposed primarily for tests and cleanup tooling.
 */
export async function clearFileStorage(options: FileStorageOptions): Promise<void> {
  await rm(options.dir, { recursive: true, force: true });
}
