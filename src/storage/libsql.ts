/**
 * libSQL / [Turso](https://turso.tech) storage adapter built on the
 * [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts) package
 * (an optional peer dependency). It speaks the same SQL dialect as SQLite but
 * works against a **remote, replicated, edge-distributed** database — or a local
 * file / embedded replica — so it suits multi-node and edge runtimes where
 * `bun:sqlite` (single-file, Bun-only) does not.
 *
 * Pass either a pre-constructed `client`, or `url` (+ optional `authToken`) to let
 * the adapter construct one lazily on first use. Keys are stored verbatim as the
 * primary key; namespace via a distinct `table` or a separate database.
 *
 * Values are stored as canonical JSON, so `compareAndSwap` is one atomic
 * `UPDATE … WHERE value = ?` evaluated by the server.
 *
 * ```ts
 * import { createLibsqlStorage } from "@xtandard/entitlements/storage/libsql";
 *
 * // Turso (remote):
 * const storage = createLibsqlStorage({
 *   url: process.env.TURSO_DATABASE_URL!,    // libsql://<db>-<org>.turso.io
 *   authToken: process.env.TURSO_AUTH_TOKEN!,
 * });
 *
 * // Local file or embedded replica:
 * // const storage = createLibsqlStorage({ url: "file:entitlements.db" });
 * ```
 *
 * @module
 */

import { requirePeer } from "./contract.ts";
import type { CompareAndSwapEntitlementsStorage } from "./contract.ts";
import { sqliteKvSchema, sqliteKvStorage, type SqliteExecutor } from "./sqlite-kv.ts";
import { assertIdentifier } from "./util.ts";

/** Options for {@link createLibsqlStorage}. */
export interface LibsqlStorageOptions {
  /** libSQL connection URL (`libsql://…`, `https://…`, `file:…`, `:memory:`). Used when no `client`. */
  url?: string;
  /** Turso auth token for remote databases. */
  authToken?: string;
  /** A pre-constructed `@libsql/client` client to use instead of connecting. */
  client?: LibsqlClientLike;
  /** Table name (default `"xtandard_entitlements_kv"`). Validated as a safe identifier. */
  table?: string;
}

/** A compare-and-swap capable storage backed by libSQL/Turso, plus `close()`. */
export interface LibsqlEntitlementsStorage extends CompareAndSwapEntitlementsStorage {
  /** Close the client if this adapter created it; no-op for a borrowed instance. */
  close(): void;
}

/** Minimal structural view of the `@libsql/client` surface the libSQL adapters use. */
export interface LibsqlClientLike {
  execute(
    stmt: string | { sql: string; args: unknown[] },
  ): Promise<{ rows: ArrayLike<Record<string, unknown>> }>;
  close(): void;
}

/** A lazily created libSQL client (internal; shared with `counters/libsql`). */
export interface LibsqlConnection {
  /** Resolve the client, running `init` (DDL) once. */
  get(): Promise<LibsqlClientLike>;
  /** Close the client if this connection created it. */
  close(): void;
}

/** Build a {@link LibsqlConnection} that runs `ddl` once before the first use. */
export function libsqlConnection(
  options: Pick<LibsqlStorageOptions, "url" | "authToken" | "client">,
  ddl: string[],
  subpath: string,
): LibsqlConnection {
  const ownsClient = !options.client;
  let client: LibsqlClientLike | undefined = options.client;
  let ready: Promise<LibsqlClientLike> | undefined;
  return {
    get(): Promise<LibsqlClientLike> {
      ready ??= (async () => {
        if (!client) {
          if (!options.url) {
            throw new Error(
              `@xtandard/entitlements/${subpath} requires either a \`client\` or a \`url\``,
            );
          }
          let createClient: (opts: { url: string; authToken?: string }) => LibsqlClientLike;
          try {
            // Non-literal specifier so the type-checker doesn't require the optional
            // peer to be installed at build time (it's resolved at runtime only).
            const specifier: string = "@libsql/client";
            ({ createClient } = (await import(specifier)) as {
              createClient: (opts: { url: string; authToken?: string }) => LibsqlClientLike;
            });
          } catch {
            requirePeer("@libsql/client", subpath);
          }
          client = createClient({ url: options.url, authToken: options.authToken });
        }
        for (const statement of ddl) await client.execute(statement);
        return client;
      })().catch((error: unknown) => {
        ready = undefined; // let a later call retry
        throw error;
      });
      return ready;
    },
    close(): void {
      if (ownsClient) client?.close();
    },
  };
}

/** Adapt a libSQL client to the positional-args executor the SQLite cores use. */
export function libsqlExecutor(client: LibsqlClientLike): SqliteExecutor {
  return {
    async all(sql, args) {
      const { rows } = await client.execute({ sql, args });
      return Array.from(rows);
    },
  };
}

/**
 * Create a libSQL/Turso-backed {@link LibsqlEntitlementsStorage}. The table is
 * created on first use; connection (when constructed from `url`) is lazy and
 * shared.
 *
 * @example
 * ```ts
 * import { createLibsqlStorage } from "@xtandard/entitlements/storage/libsql";
 *
 * const storage = createLibsqlStorage({
 *   url: process.env.TURSO_DATABASE_URL!,
 *   authToken: process.env.TURSO_AUTH_TOKEN,
 * });
 * // process.on("SIGTERM", () => storage.close());
 * ```
 */
export function createLibsqlStorage(options: LibsqlStorageOptions): LibsqlEntitlementsStorage {
  const table = assertIdentifier(options.table ?? "xtandard_entitlements_kv");
  const connection = libsqlConnection(options, [sqliteKvSchema(table)], "storage/libsql");
  return {
    ...sqliteKvStorage(table, async () => libsqlExecutor(await connection.get())),
    close: connection.close,
  };
}
