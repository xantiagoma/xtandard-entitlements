import { defineConfig } from "vite-plus";
import { defineXtandardConfig } from "@xtandard/kit/build";

// The family skeleton (core + elysia2 test projects, retry, v8 coverage, lint/fmt
// ignores, the staged formatter, ESM + CJS pack with bun:* never bundled) is the
// kit's; entitlements passes its entries, its type tests and its Bun-only drivers.
export default defineConfig(
  defineXtandardConfig({
    entries: [
      "src/index.ts",
      "src/catalog.ts",
      "src/testing.ts",
      "src/entry-storage-memory.ts",
      "src/entry-counters-memory.ts",
      "src/entry-counters-buffered.ts",
      "src/entry-counters-kv.ts",
      "src/entry-react.ts",
      "src/entry-billing.ts",
      "src/entry-billing-stripe.ts",
      "src/entry-billing-polar.ts",
      "src/entry-billing-paddle.ts",
      "src/entry-billing-lemonsqueezy.ts",
      "src/entry-billing-better-auth.ts",
      "src/entry-billing-manual.ts",
      "src/entry-flags.ts",
      "src/entry-bridges-audit.ts",
      "src/entry-bridges-webhooks.ts",
      "src/entry-storage-file.ts",
      "src/entry-storage-redis.ts",
      "src/entry-storage-postgres.ts",
      "src/entry-storage-drizzle.ts",
      "src/entry-storage-mongodb.ts",
      "src/entry-storage-sqlite.ts",
      "src/entry-storage-libsql.ts",
      "src/entry-storage-unstorage.ts",
      "src/entry-storage-cloudflare-kv.ts",
      "src/entry-drizzle-pg.ts",
      "src/entry-drizzle-mysql.ts",
      "src/entry-drizzle-sqlite.ts",
      "src/entry-counters-redis.ts",
      "src/entry-counters-postgres.ts",
      "src/entry-counters-sqlite.ts",
      "src/entry-counters-libsql.ts",
      "src/entry-counters-mongodb.ts",
      "src/entry-counters-drizzle.ts",
      "src/entry-auth-none.ts",
      "src/entry-auth-basic.ts",
      "src/entry-auth-delegated.ts",
      "src/entry-authorization-none.ts",
      "src/entry-authorization-roles.ts",
      "src/entry-authorization-delegated.ts",
      "src/entry-hooks-log.ts",
      "src/entry-bun.ts",
      "src/entry-elysia.ts",
      // Runtime JS only: its .d.ts is emitted against Elysia 2 by build:elysia2-types.
      "src/entry-elysia2.ts",
      "src/entry-express.ts",
      "src/entry-hono.ts",
      "src/entry-next.ts",
      // CLI entry point (bin/xtandard-entitlements.mjs → dist/cli.mjs).
      "src/cli.ts",
    ],
    typecheck: true,
    coverage: {
      // bun:sqlite only exists under Bun — covered by `bun run test:bun`, not vitest.
      exclude: ["src/storage/sqlite.ts", "src/counters/sqlite.ts"],
    },
  }),
);
