/**
 * MongoDB storage adapter built on the [`mongodb`](https://github.com/mongodb/node-mongodb-native)
 * driver, an optional peer dependency. You can either pass a pre-constructed
 * (optionally pre-connected) `MongoClient`, or a connection `url` to create and
 * connect a client lazily on first use.
 *
 * The backend is a single collection of `{ _id: <key>, value: <any> }` documents.
 * The storage key is stored verbatim as the document `_id`, and the value is
 * stored directly as a BSON field — MongoDB persists arbitrary objects, arrays,
 * and primitives, so no JSON (de)serialisation round-trip is needed. Object
 * keys are written in sorted (canonical) order, because BSON document equality
 * is field-order sensitive and `compareAndSwap` relies on it.
 *
 * `getKeys(prefix)` matches `_id` against an anchored, escaped regular
 * expression (`^<prefix>`; case-sensitive), projecting only `_id` so the server
 * never ships values back for a key listing.
 *
 * `compareAndSwap` is one `updateOne({ _id, $expr: { $eq: ["$value", expected] } })`
 * (or an `insertOne` guarded by the unique `_id` when absence is expected), so it
 * is atomic on any deployment, standalone included.
 *
 * ## Why no `watch`
 *
 * MongoDB change streams (the natural way to back a watchable storage) require
 * a replica set or sharded cluster — they are unavailable on a standalone
 * `mongod`. To keep this adapter usable against any deployment, `watch` is
 * intentionally **not** implemented; the engine feature-detects its absence via
 * `isWatchable` and relies on its cache TTL instead.
 *
 * @module
 */

import type { Collection, Document, MongoClient } from "mongodb";
import { requirePeer } from "./contract.ts";
import type { CompareAndSwapEntitlementsStorage } from "./contract.ts";
import { canonical, escapeRegex } from "./util.ts";

/** Options for {@link createMongoStorage}. */
export interface MongoStorageOptions {
  /** A pre-constructed (optionally pre-connected) mongodb `MongoClient`. */
  client?: MongoClient;
  /**
   * Connection string (e.g. `mongodb://localhost:27017`). When no `client` is
   * given, a `MongoClient` is created lazily on first use via a dynamic
   * `import("mongodb")`.
   */
  url?: string;
  /** Database name. Defaults to `"xtandard_entitlements"`. */
  dbName?: string;
  /** Collection name. Defaults to `"entitlements_kv"`. */
  collectionName?: string;
}

/**
 * A compare-and-swap capable storage backed by MongoDB, plus a `close()` method
 * that disconnects the client — but only the one this adapter created. A client
 * you passed in is left for you to manage.
 */
export interface MongoEntitlementsStorage extends CompareAndSwapEntitlementsStorage {
  /** Disconnect the underlying client if this adapter created it. No-op otherwise. */
  close(): Promise<void>;
}

/** Shape of a single key/value document stored in the backing collection. */
interface KvDoc extends Document {
  /** The storage key, stored verbatim as the Mongo document id. */
  _id: string;
  /** The stored value — arbitrary BSON (object, array, or primitive). */
  value: unknown;
}

/** A lazily connected Mongo database handle (internal; shared with `counters/mongodb`). */
export interface MongoConnection {
  /** Resolve a connected collection, creating/connecting the client on first use. */
  collection<T extends Document>(name: string): Promise<Collection<T>>;
  /** Close the client if this connection created it. */
  close(): Promise<void>;
}

/** Build a {@link MongoConnection}. */
export function mongoConnection(
  options: { client?: MongoClient; url?: string; dbName: string },
  subpath: string,
): MongoConnection {
  const ownsClient = !options.client;
  let client: MongoClient | undefined = options.client;
  let connecting: Promise<MongoClient> | undefined;

  async function connect(): Promise<MongoClient> {
    connecting ??= (async () => {
      if (!client) {
        let MongoClientCtor: new (url: string) => MongoClient;
        try {
          ({ MongoClient: MongoClientCtor } = (await import("mongodb")) as unknown as {
            MongoClient: new (url: string) => MongoClient;
          });
        } catch {
          requirePeer("mongodb", subpath);
        }
        if (options.url === undefined) {
          throw new Error(
            `@xtandard/entitlements/${subpath} requires either a "client" or a "url" option.`,
          );
        }
        client = new MongoClientCtor(options.url);
      }
      // node-mongodb's connect() is idempotent — calling it on an already
      // connected client is a no-op — but guard regardless so a passed-in,
      // already-connected client never surfaces a spurious error.
      try {
        await client.connect();
      } catch (error) {
        if (!isAlreadyConnected(error)) throw error;
      }
      return client;
    })();
    try {
      return await connecting;
    } catch (error) {
      // Let a later operation retry the connection rather than caching a failure.
      connecting = undefined;
      throw error;
    }
  }

  return {
    async collection<T extends Document>(name: string): Promise<Collection<T>> {
      return (await connect()).db(options.dbName).collection<T>(name);
    },
    async close(): Promise<void> {
      if (ownsClient && client) await client.close();
    },
  };
}

/** True for a MongoDB duplicate-key error (E11000). */
export function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/**
 * Create a MongoDB-backed {@link MongoEntitlementsStorage}. Connection is lazy:
 * the client is created/connected on the first storage operation and reused
 * thereafter, guarded by a single connection promise so concurrent calls connect
 * once.
 *
 * @example
 * ```ts
 * import { createMongoStorage } from "@xtandard/entitlements/storage/mongodb";
 *
 * const storage = createMongoStorage({
 *   url: process.env.MONGODB_URL ?? "mongodb://localhost:27017",
 *   dbName: "myapp",
 *   collectionName: "entitlements_kv",
 * });
 *
 * // Disconnect when the process exits:
 * // process.on("SIGTERM", () => storage.close());
 * ```
 */
export function createMongoStorage(options: MongoStorageOptions): MongoEntitlementsStorage {
  const { dbName = "xtandard_entitlements", collectionName = "entitlements_kv" } = options;
  const connection = mongoConnection({ ...options, dbName }, "storage/mongodb");
  const getCollection = () => connection.collection<KvDoc>(collectionName);

  return {
    async getItem<T>(key: string): Promise<T | null> {
      const collection = await getCollection();
      const doc = await collection.findOne({ _id: key });
      return doc ? (doc.value as T) : null;
    },

    async setItem<T>(key: string, value: T): Promise<void> {
      const collection = await getCollection();
      await collection.updateOne(
        { _id: key },
        { $set: { value: canonical(value) } },
        { upsert: true },
      );
    },

    async removeItem(key: string): Promise<void> {
      const collection = await getCollection();
      await collection.deleteOne({ _id: key });
    },

    async getKeys(prefix: string): Promise<string[]> {
      const collection = await getCollection();
      const cursor = collection
        .find({ _id: { $regex: `^${escapeRegex(prefix)}` } })
        .project<{ _id: string }>({ _id: 1 });
      const out: string[] = [];
      for await (const doc of cursor) if (doc._id.startsWith(prefix)) out.push(doc._id);
      return out;
    },

    async compareAndSwap<T>(input: { key: string; expected: T | null; next: T }): Promise<boolean> {
      const collection = await getCollection();
      const next = canonical(input.next);
      if (input.expected === null) {
        try {
          await collection.insertOne({ _id: input.key, value: next });
          return true;
        } catch (error) {
          if (isDuplicateKey(error)) return false;
          throw error;
        }
      }
      // `$expr` + `$literal`: exact (non array-traversing) equality, and a value
      // containing `$`-prefixed keys is never interpreted as an expression.
      const result = await collection.updateOne(
        {
          _id: input.key,
          $expr: { $eq: ["$value", { $literal: canonical(input.expected) }] },
        },
        { $set: { value: next } },
      );
      return result.matchedCount === 1;
    },

    close: connection.close,
  } satisfies MongoEntitlementsStorage;
}

/**
 * Heuristic: does this error indicate the client was already connected? The
 * driver's exact message has varied across versions, so match loosely.
 */
function isAlreadyConnected(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("already") && message.includes("connect");
}
