/**
 * Cloudflare Workers KV storage adapter. It wraps a `KVNamespace` **binding** —
 * the object Workers exposes on `env.MY_KV` — so it works in production Workers,
 * in local dev via `wrangler dev` / [Miniflare](https://miniflare.dev), and in
 * tests against any object that satisfies the small {@link KVNamespaceLike}
 * surface. There is **no npm peer dependency**: the binding is provided by the
 * runtime, so this adapter only needs the structural type.
 *
 * KV is eventually consistent (writes take up to ~60 s to reach every
 * location) and has list pagination — fine for catalog-adjacent state that
 * changes rarely, but it has **no atomic primitive**: there is no
 * `compareAndSwap`, and it cannot back `counters/kv`. Pair it with a real
 * counter store (Redis, Postgres, a Durable Object). An optional `prefix`
 * namespaces every key (joined with `:`) and is stripped from
 * {@link CloudflareKvEntitlementsStorage.getKeys} results, so several
 * deployments can share one namespace.
 *
 * ```ts
 * import { createCloudflareKvStorage } from "@xtandard/entitlements/storage/cloudflare-kv";
 *
 * export default {
 *   async fetch(req: Request, env: { ENTITLEMENTS: KVNamespace }) {
 *     const storage = createCloudflareKvStorage({ namespace: env.ENTITLEMENTS, prefix: "prod" });
 *     // …build the engine over `storage`…
 *   },
 * };
 * ```
 *
 * The driver is `@xtandard/kit/storage/cloudflare-kv`.
 *
 * @module
 */

export {
  createCloudflareKvStorage,
  type CloudflareKvStorage as CloudflareKvEntitlementsStorage,
  type CloudflareKvStorageOptions,
  type KVNamespaceLike,
} from "@xtandard/kit/storage/cloudflare-kv";
