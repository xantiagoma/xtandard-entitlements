/**
 * MongoDB counter store over the [`mongodb`](https://github.com/mongodb/node-mongodb-native)
 * driver (an optional peer) — ADR 0004.
 *
 * - `add` is **one `findOneAndUpdate`** with an aggregation-pipeline update and
 *   `upsert: true`: the pipeline reads the current value (treating an expired
 *   document as `0`), decides how much applies (`$cond` mirroring
 *   {@link computeApplied}) and writes `value` / `applied` / `expiresAt` in the
 *   same single-document atomic operation. A concurrent first insert of the same
 *   `_id` (duplicate-key race) is retried.
 * - `claim` inserts `{ _id: "_claims/<key>" }` (the unique `_id` makes exactly
 *   one concurrent claimer win) and otherwise takes over an expired claim with
 *   a conditional `updateOne`.
 * - `expiresAt` is stored as a BSON `Date`; by default a TTL index
 *   (`expireAfterSeconds: 0`) lets MongoDB delete expired counters and claims
 *   in the background. Reads never depend on it — an expired document reads as
 *   `0` either way.
 *
 * Documents: `{ _id: key, value: number, applied: number, expiresAt: Date | null }`.
 *
 * @module
 */

import type { Collection, Document, MongoClient } from "mongodb";
import { escapeRegex } from "@xtandard/kit/storage";
import { isDuplicateKey, mongoConnection } from "@xtandard/kit/storage/mongodb/internals";
import { assertAmount, type CounterAddOptions, type CounterStore } from "./contract.ts";
import { CLAIM_PREFIX } from "./sql.ts";

/** Options for {@link createMongoCounterStore}. */
export interface MongoCounterStoreOptions {
  /** A pre-constructed (optionally pre-connected) `MongoClient`. */
  client?: MongoClient;
  /** Connection string, used to create a client lazily when no `client` is given. */
  url?: string;
  /** Database name. Default `"xtandard_entitlements"`. */
  dbName?: string;
  /** Collection name. Default `"entitlements_counters"`. */
  collectionName?: string;
  /** Create a TTL index on `expiresAt` on first use. Default `true`. */
  ttlIndex?: boolean;
  /** Clock (unix ms) for expiry hints and claim TTLs. Default `Date.now`. */
  now?: () => number;
}

/** A MongoDB {@link CounterStore} with `keys` and `close()`. */
export interface MongoCounterStore extends CounterStore {
  keys(prefix: string): Promise<string[]>;
  /** Disconnect the client if this store created it. */
  close(): Promise<void>;
}

interface CounterDoc extends Document {
  _id: string;
  value: number;
  applied: number;
  expiresAt: Date | null;
}

const lit = (value: unknown) => ({ $literal: value });

/** Aggregation expression for {@link computeApplied} against `$_cur`. */
function appliedExpr(amount: number, options: CounterAddOptions): unknown {
  if (amount > 0 && options.max !== undefined) {
    const room = { $subtract: [lit(options.max), "$_cur"] };
    return {
      $cond: [{ $gt: [lit(amount), room] }, options.partial ? { $max: [0, room] } : 0, lit(amount)],
    };
  }
  if (amount < 0 && options.min !== undefined) {
    const room = { $subtract: ["$_cur", lit(options.min)] };
    return {
      $cond: [
        { $gt: [lit(-amount), room] },
        options.partial ? { $subtract: [0, { $max: [0, room] }] } : 0,
        lit(amount),
      ],
    };
  }
  return lit(amount);
}

/**
 * Create a MongoDB-backed counter store. Connection (and the TTL index) is
 * lazy — set up on the first operation.
 *
 * @example
 * ```ts
 * import { createMongoCounterStore } from "@xtandard/entitlements/counters/mongodb";
 * const counters = createMongoCounterStore({ url: process.env.MONGODB_URL, dbName: "myapp" });
 * ```
 */
export function createMongoCounterStore(options: MongoCounterStoreOptions): MongoCounterStore {
  const {
    dbName = "xtandard_entitlements",
    collectionName = "entitlements_counters",
    now = Date.now,
  } = options;
  const connection = mongoConnection(
    { ...options, dbName },
    "@xtandard/entitlements/counters/mongodb",
  );
  let indexed: Promise<unknown> | undefined;

  async function collection(): Promise<Collection<CounterDoc>> {
    const c = await connection.collection<CounterDoc>(collectionName);
    if (options.ttlIndex !== false) {
      indexed ??= c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {
        indexed = undefined; // best effort; retried on a later call
      });
      await indexed;
    }
    return c;
  }

  const live = (t: number) => ({ $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date(t) } }] });

  return {
    async get(keys) {
      if (keys.length === 0) return [];
      const c = await collection();
      const docs = await c
        .find({ _id: { $in: [...keys] }, ...live(now()) })
        .project<{ _id: string; value: number }>({ value: 1 })
        .toArray();
      const byKey = new Map(docs.map((d) => [d._id, Number(d.value)]));
      return keys.map((k) => byKey.get(k) ?? 0);
    },

    async add(key, amount, opts = {}) {
      assertAmount(amount);
      const t = new Date(now());
      const exp = opts.expiresAt === undefined ? null : new Date(Math.trunc(opts.expiresAt));
      const expired = {
        $and: [{ $ne: [{ $ifNull: ["$expiresAt", null] }, null] }, { $lte: ["$expiresAt", t] }],
      };
      const pipeline = [
        {
          $set: {
            _expired: expired,
            _new: { $eq: [{ $ifNull: ["$value", null] }, null] },
            _cur: { $cond: [expired, 0, { $ifNull: ["$value", 0] }] },
          },
        },
        { $set: { applied: appliedExpr(amount, opts) } },
        {
          $set: {
            value: { $add: ["$_cur", "$applied"] },
            expiresAt:
              exp === null
                ? { $cond: [{ $or: ["$_expired", "$_new"] }, null, "$expiresAt"] }
                : {
                    $cond: [
                      { $or: ["$_expired", "$_new", { $ne: ["$applied", 0] }] },
                      lit(exp),
                      "$expiresAt",
                    ],
                  },
          },
        },
        { $unset: ["_expired", "_new", "_cur"] },
      ];
      const c = await collection();
      for (let attempt = 0; ; attempt++) {
        try {
          const doc = await c.findOneAndUpdate({ _id: key }, pipeline, {
            upsert: true,
            returnDocument: "after",
            projection: { value: 1, applied: 1 },
          });
          return { applied: Number(doc!.applied) || 0, value: Number(doc!.value) };
        } catch (error) {
          // Two first-writers raced to insert the same _id: the loser retries as an update.
          if (!isDuplicateKey(error) || attempt >= 3) throw error;
        }
      }
    },

    async set(key, value, opts = {}) {
      assertAmount(value);
      const c = await collection();
      await c.updateOne(
        { _id: key },
        {
          $set: {
            value,
            applied: 0,
            expiresAt: opts.expiresAt === undefined ? null : new Date(Math.trunc(opts.expiresAt)),
          },
        },
        { upsert: true },
      );
    },

    async claim(key, ttlMs) {
      const c = await collection();
      const t = now();
      const until = new Date(t + ttlMs);
      const id = CLAIM_PREFIX + key;
      try {
        await c.insertOne({ _id: id, value: 0, applied: 1, expiresAt: until });
        return true;
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      const result = await c.updateOne(
        { _id: id, expiresAt: { $lte: new Date(t) } },
        { $set: { expiresAt: until } },
      );
      return result.modifiedCount === 1;
    },

    async release(key) {
      const c = await collection();
      await c.deleteOne({ _id: CLAIM_PREFIX + key });
    },

    async delete(keys) {
      if (keys.length === 0) return;
      const c = await collection();
      await c.deleteMany({ _id: { $in: [...keys] } });
    },

    async keys(prefix) {
      const c = await collection();
      const docs = await c
        .find({ _id: { $regex: `^${escapeRegex(prefix)}` }, value: { $ne: 0 }, ...live(now()) })
        .project<{ _id: string }>({ _id: 1 })
        .toArray();
      return docs
        .map((d) => d._id)
        .filter((k) => k.startsWith(prefix) && !k.startsWith(CLAIM_PREFIX));
    },

    close: connection.close,
  };
}
