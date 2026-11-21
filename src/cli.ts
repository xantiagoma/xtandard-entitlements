/**
 * `xtandard-entitlements` CLI. Operates on the same catalog and storage your
 * app / panel uses — the catalog module via `--catalog <path>` (or
 * `CATALOG_PATH`), state storage and counters via `--storage` / `--counters`
 * (or `STORAGE_DRIVER` / `COUNTERS_DRIVER` + the driver env vars, mirroring the
 * standalone app) — so it slots into shell, CI and support workflows.
 *
 * Commands: `serve` (panel + API, no Docker), `check`, `consume`, `grant`,
 * `override`, `subscribe`, `customers`, `pricing` (prints the pricing JSON) and
 * `sweep` (release expired reservations).
 *
 * @module
 */

import {
  buildAuthFromEnv,
  describeStorage,
  env,
  isMainModule,
  parseArgs as kitParseArgs,
  pkgVersion as kitPkgVersion,
  resolveStorageConfig,
  serve as kitServe,
  storageFromEnv,
  storageRegistryFrom,
  type StorageConfig,
  type StorageRole,
} from "@xtandard/kit/cli";
import type { AnyCatalog, JsonValue } from "./catalog.ts";
import type { CounterStore } from "./counters/contract.ts";
import type { Duration } from "./duration.ts";
import type { Entitlements } from "./engine.ts";
import type { Actor, SubscriptionStatus } from "./schema.ts";
import type { EntitlementsStorage } from "./storage/contract.ts";

/** State storage drivers the CLI can build from env. */
export type StorageDriver =
  | "memory"
  | "file"
  | "redis"
  | "postgres"
  | "mongodb"
  | "sqlite"
  | "libsql";

/** Counter drivers the CLI can build from env (`kv` = CAS counters over the state storage). */
export type CountersDriver =
  | "memory"
  | "kv"
  | "redis"
  | "postgres"
  | "mongodb"
  | "sqlite"
  | "libsql";

const STORAGE_DRIVERS: readonly StorageDriver[] = [
  "memory",
  "file",
  "redis",
  "postgres",
  "mongodb",
  "sqlite",
  "libsql",
];
const COUNTERS_DRIVERS: readonly CountersDriver[] = [
  "memory",
  "kv",
  "redis",
  "postgres",
  "mongodb",
  "sqlite",
  "libsql",
];

/** The actor recorded for CLI-made control-plane changes. */
const CLI_ACTOR: Actor = { id: "cli", type: "system", name: "xtandard-entitlements CLI" };

/**
 * The state-storage role. Its defaults are the persisted names earlier
 * releases used (ADR 0005); each `STORAGE_*` env var still overrides them.
 */
const STORAGE_ROLE: StorageRole = {
  name: "STORAGE",
  defaults: {
    driver: "file",
    prefix: "xtandard:entitlements",
    pgTable: "xtandard_entitlements_kv",
    mongoDb: "xtandard_entitlements",
    mongoCollection: "entitlements_kv",
    sqlitePath: "./.entitlements/state.sqlite",
    sqliteTable: "xtandard_entitlements_kv",
    libsqlUrl: "file:./.entitlements/state.db",
    fileDir: "./.entitlements/state",
  },
};

/**
 * The counters role (`COUNTERS_DRIVER`, `COUNTERS_*`). Tables and collections
 * default to the counter factories' own names when their env vars are unset.
 */
const COUNTERS_ROLE: StorageRole = {
  name: "COUNTERS",
  driverEnv: "COUNTERS_DRIVER",
  defaults: {
    prefix: "xtandard:entitlements:counters",
    mongoDb: "xtandard_entitlements",
    sqlitePath: "./.entitlements/counters.sqlite",
    libsqlUrl: "file:./.entitlements/counters.db",
  },
};

/**
 * This package's own wrapped drivers (its persisted defaults and import paths),
 * loaded lazily so optional peers load only when chosen. Run from TypeScript
 * source (tests, the standalone app) the entries are `./entry-*.ts`; compiled,
 * the sibling `./entry-*.mjs`.
 */
const entry = (name: string) => (): Promise<unknown> => {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".mjs";
  return import(/* @vite-ignore */ new URL(`./entry-${name}${ext}`, import.meta.url).href);
};
const STORAGE_REGISTRY = storageRegistryFrom({
  memory: entry("storage-memory"),
  file: entry("storage-file"),
  redis: entry("storage-redis"),
  postgres: entry("storage-postgres"),
  mongodb: entry("storage-mongodb"),
  sqlite: entry("storage-sqlite"),
  libsql: entry("storage-libsql"),
});

/** Options shared by every command: where the catalog / state / counters come from. */
export interface CliEnvironment {
  /** Path to a module exporting `catalog` (or a default export). */
  catalogPath?: string;
  storage?: StorageDriver;
  counters?: CountersDriver;
}

function pickDriver<T extends string>(
  name: string,
  value: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unknown ${name} "${value}" (expected one of: ${allowed.join(", ")})`);
}

/** The process env with one role's driver variable set to `driver`. */
const withDriver = (role: StorageRole, driver: string) => ({
  ...process.env,
  [role.driverEnv ?? `${role.name}_DRIVER`]: driver,
});

/**
 * Build the state storage from env (`STORAGE_DRIVER`, default `file` —
 * `./.entitlements/state`). Connection-string drivers read `REDIS_URL`,
 * `DATABASE_URL` / `POSTGRES_URL`, `MONGO_URL`, `LIBSQL_URL`, ….
 */
export async function buildStorage(driver: StorageDriver): Promise<EntitlementsStorage> {
  return storageFromEnv<EntitlementsStorage>({
    role: STORAGE_ROLE,
    drivers: STORAGE_REGISTRY as never,
    env: withDriver(STORAGE_ROLE, driver),
    allowed: STORAGE_DRIVERS,
  });
}

/**
 * Build the counter store from env (`COUNTERS_DRIVER`). Default: `kv` (atomic
 * CAS counters inside the state storage) when the storage supports
 * compare-and-swap, otherwise `memory` (with a warning — usage is then not
 * persisted across CLI invocations).
 */
export async function buildCounters(
  driver: CountersDriver | undefined,
  storage: EntitlementsStorage,
): Promise<{ counters: CounterStore; driver: CountersDriver }> {
  const { isCompareAndSwap } = await import("./storage/contract.ts");
  const chosen: CountersDriver = driver ?? (isCompareAndSwap(storage) ? "kv" : "memory");
  if (!driver && chosen === "memory") {
    process.stderr.write(
      "[xtandard/entitlements] counters: memory (the storage has no compare-and-swap) — usage is not persisted. Set COUNTERS_DRIVER.\n",
    );
  }
  const config = resolveStorageConfig(COUNTERS_ROLE, {
    env: withDriver(COUNTERS_ROLE, chosen),
    allowed: COUNTERS_DRIVERS,
  });
  return { counters: await counterStore(chosen, config, storage), driver: chosen };
}

/** Load one of this package's counter entries and call its factory. */
async function counterEntry(
  name: string,
  factory: string,
  options: Record<string, unknown>,
): Promise<CounterStore> {
  let mod: Record<string, (o: Record<string, unknown>) => CounterStore>;
  try {
    mod = (await entry(name)()) as typeof mod;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || /Cannot find module/i.test(String(err))) {
      throw new Error(
        `The "${name.replace("-", "/")}" driver is not available in this build (${String(err)}).`,
      );
    }
    throw err;
  }
  return mod[factory]!(
    Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
  );
}

async function counterStore(
  chosen: CountersDriver,
  c: StorageConfig,
  storage: EntitlementsStorage,
): Promise<CounterStore> {
  switch (chosen) {
    case "memory": {
      const { createMemoryCounterStore } = await import("./counters/memory.ts");
      return createMemoryCounterStore();
    }
    case "kv": {
      const { createKvCounterStore } = await import("./counters/kv.ts");
      return createKvCounterStore(storage);
    }
    case "redis":
      return counterEntry("counters-redis", "createRedisCounterStore", {
        url: c.redisUrl,
        prefix: c.prefix,
      });
    case "postgres":
      return counterEntry("counters-postgres", "createPostgresCounterStore", {
        connectionString: c.postgresUrl,
        table: c.pgTable,
      });
    case "mongodb":
      return counterEntry("counters-mongodb", "createMongoCounterStore", {
        url: c.mongoUrl,
        dbName: c.mongoDb,
        collectionName: c.mongoCollection,
      });
    case "sqlite":
      return counterEntry("counters-sqlite", "createSqliteCounterStore", {
        path: c.sqlitePath,
        table: c.sqliteTable,
      });
    case "libsql":
      return counterEntry("counters-libsql", "createLibsqlCounterStore", {
        url: c.libsqlUrl,
        authToken: c.libsqlAuthToken,
        table: c.sqliteTable,
      });
  }
}

/**
 * Load the catalog module: `export const catalog = defineCatalog(…)` or
 * `export default defineCatalog(…)`. Relative paths resolve from the cwd.
 */
export async function loadCatalog(path: string): Promise<AnyCatalog> {
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const mod = (await import(
    /* @vite-ignore */ pathToFileURL(resolve(process.cwd(), path)).href
  )) as { catalog?: unknown; default?: unknown };
  const candidate = mod.catalog ?? mod.default;
  const isCatalog = (value: unknown): value is AnyCatalog =>
    typeof value === "object" && value !== null && "normalized" in value && "features" in value;
  if (isCatalog(candidate)) return candidate;
  // `export default { catalog }` (CJS interop) — one more level.
  const nested = (candidate as { catalog?: unknown } | undefined)?.catalog;
  if (isCatalog(nested)) return nested;
  throw new Error(
    `${path} does not export a catalog — expected \`export const catalog = defineCatalog(…)\` or a default export.`,
  );
}

/** Minimal flag/value argv parser: `--key value`, `--key=value` and `--flag`. */
export function parseArgs(argv: string[]): {
  _: string[];
  flags: Record<string, string | boolean>;
} {
  // `--version 1` is `subscribe`'s plan version: no flag is boolean-only here.
  const { _, flags } = kitParseArgs(argv, { short: {}, boolean: [] });
  return { _: [..._], flags: { ...flags } };
}

/** Read this package's version from the nearest package.json (dist or src). */
const pkgVersion = (): Promise<string> => kitPkgVersion(import.meta.url);

function helpText(version: string): string {
  return `xtandard-entitlements v${version} — entitlements, plans and usage metering

Usage:
  xtandard-entitlements <command> --catalog <path> [options]
  npx @xtandard/entitlements <command> …     # or: bunx @xtandard/entitlements …

Commands:
  serve [--port <n>]                Run the admin panel + customer portal + HTTP API (no Docker).
  check --customer <id> --feature <key> [--amount <n>]
                                    Print the decision (exit 2 when denied).
  consume --customer <id> --feature <key> [--amount <n>] [--idempotency-key <k>]
                                    Atomically consume units (exit 2 when refused).
  grant --customer <id> --feature <key> --amount <n> [--expires-at <iso>] [--reason <text>] [--recurring]
                                    Add a balance to a numeric feature.
  override --customer <id> --feature <key> [--enabled true|false] [--limit <n>|unlimited]
           [--value '<json>'] [--expires-at <iso>] [--reason <text>]
                                    Comp / raise / disable one feature for one customer.
  subscribe --customer <id> --plan <key> [--version <n>] [--quantity <n>] [--status <s>] [--trial-ends-at <iso>]
                                    Manual plan or add-on subscription.
  customers [--search <text>] [--limit <n>]
                                    List customers.
  pricing [--include-hidden]        Print the pricing table JSON (catalog only, no storage).
  sweep                             Release expired reservations.

Global options:
  --catalog <path>                  Module exporting \`catalog\` (or default). Env: CATALOG_PATH.
  --storage <driver>                ${STORAGE_DRIVERS.join(" | ")}  (env STORAGE_DRIVER, default file)
  --counters <driver>               ${COUNTERS_DRIVERS.join(" | ")}  (env COUNTERS_DRIVER;
                                    default kv when the storage has compare-and-swap, else memory)
  --json                            Machine-readable output (check / consume / grant / … print JSON anyway).
  -h, --help                        Show this help.
  -v, --version                     Print the version.

Environment variables
  Storage:
    STORAGE_DRIVER, COUNTERS_DRIVER  see above (Docker default: memory)
    REDIS_URL                        redis://localhost:6379        (redis)
    STORAGE_PREFIX, COUNTERS_PREFIX  key namespaces                (redis)
    DATABASE_URL | POSTGRES_URL      postgres://…                  (postgres)
    STORAGE_PG_TABLE, COUNTERS_PG_TABLE                            (postgres)
    MONGO_URL, MONGO_DB, STORAGE_MONGO_COLLECTION, COUNTERS_MONGO_COLLECTION (mongodb)
    STORAGE_FILE_DIR                 default ./.entitlements/state  (file)
    STORAGE_SQLITE_PATH, COUNTERS_SQLITE_PATH                       (sqlite, Bun only)
    LIBSQL_URL, COUNTERS_LIBSQL_URL, LIBSQL_AUTH_TOKEN              (libsql)

  Server (\`serve\` / standalone):
    PORT            3000        Port to listen on (or --port).
    BASE_PATH       ""          URL prefix, e.g. "/billing".
    TITLE                       Navbar wordmark.
    LOGO_URL                    Logo image URL.
    READONLY        1|true      Block control-plane mutations (metering keeps working).
    AUTH_MODE       none|basic  Authentication mode (default none).
    AUTH_USERNAME   admin       Username for basic auth.
    AUTH_ROLE       admin       Role of that user (viewer | support | billing-admin | admin | runtime-service).
    AUTH_PASSWORD_HASH          scrypt hash (preferred; see docs/AUTH.md).
    AUTH_PASSWORD               Plaintext password (dev only).
    PORTAL_SECRET               Enables customer-portal tokens (entpt_… bearer tokens).
    SWEEP_INTERVAL  1m          Release expired reservations this often ("0" disables).

Examples:
  # Quick local panel (file storage, no auth):
  npx @xtandard/entitlements serve --catalog ./src/catalog.ts --port 3005

  # Support: comp PDF export for a customer for 30 days:
  xtandard-entitlements override --catalog ./catalog.ts --customer org_42 --feature export_pdf \\
    --enabled true --expires-at 2026-12-31T00:00:00Z --reason "support ticket #123"

  # CI smoke test against production state (exit 2 when denied):
  STORAGE_DRIVER=redis COUNTERS_DRIVER=redis REDIS_URL=redis://… \\
    xtandard-entitlements check --catalog ./catalog.ts --customer org_42 --feature api_calls

  # Publish the pricing JSON for a static marketing site:
  xtandard-entitlements pricing --catalog ./catalog.ts > public/pricing.json

Docs: https://github.com/xantiagoma/xtandard-entitlements
`;
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

function num(flags: Record<string, string | boolean>, key: string): number | undefined {
  const raw = str(flags[key]);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${raw}"`);
  return n;
}

function bool(flags: Record<string, string | boolean>, key: string): boolean | undefined {
  const raw = flags[key];
  if (raw === undefined) return undefined;
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`--${key} must be true or false, got "${String(raw)}"`);
}

function required(flags: Record<string, string | boolean>, keys: string[], usage: string): void {
  const missing = keys.filter((k) => typeof flags[k] !== "string");
  if (missing.length) {
    throw new UsageError(`Missing ${missing.map((k) => `--${k}`).join(", ")}\nUsage: ${usage}`);
  }
}

/** A usage problem: printed without the "Error:" prefix, exit code 1. */
class UsageError extends Error {}

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

/** Entry point. Returns the process exit code (0 ok, 1 error, 2 denied). */
export async function run(argv: string[]): Promise<number> {
  const { _, flags } = parseArgs(argv);
  const command = _[0];

  if (flags.version === true || argv.includes("-v") || command === "version") {
    process.stdout.write(`${await pkgVersion()}\n`);
    return 0;
  }

  const wantsHelp = Boolean(flags.help) || argv.includes("-h") || command === "help";
  if (!command || wantsHelp) {
    process.stdout.write(helpText(await pkgVersion()));
    return wantsHelp ? 0 : 1;
  }

  const known = [
    "serve",
    "check",
    "consume",
    "grant",
    "override",
    "subscribe",
    "customers",
    "pricing",
    "sweep",
  ];
  if (!known.includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${helpText(await pkgVersion())}`);
    return 1;
  }

  let engine: Entitlements<AnyCatalog> | undefined;
  try {
    const catalogPath = str(flags.catalog) ?? env("CATALOG_PATH");
    if (!catalogPath) {
      throw new UsageError(
        "Missing --catalog <path> (or CATALOG_PATH): a module exporting your catalog.",
      );
    }
    const catalog = await loadCatalog(catalogPath);

    if (command === "pricing") {
      const { pricingTable } = await import("./catalog.ts");
      print(pricingTable(catalog, { includeHidden: flags["include-hidden"] === true }));
      return 0;
    }

    const storageDriver = pickDriver(
      "storage driver",
      str(flags.storage) ?? env("STORAGE_DRIVER"),
      STORAGE_DRIVERS,
      "file",
    );
    const countersRaw = str(flags.counters) ?? env("COUNTERS_DRIVER");
    const countersDriver = countersRaw
      ? pickDriver("counters driver", countersRaw, COUNTERS_DRIVERS, "memory")
      : undefined;
    const storage = await buildStorage(storageDriver);
    const { counters, driver: chosenCounters } = await buildCounters(countersDriver, storage);

    if (command === "serve") {
      return await serve({ catalog, storage, counters, storageDriver, chosenCounters, flags });
    }

    const { createEntitlements } = await import("./engine.ts");
    engine = createEntitlements({ catalog, storage, counters, cache: false });
    const actor = { actor: CLI_ACTOR };

    switch (command) {
      case "check": {
        required(flags, ["customer", "feature"], "check --customer <id> --feature <key>");
        const amount = num(flags, "amount");
        const result = await engine.check(
          str(flags.customer)!,
          str(flags.feature)!,
          amount !== undefined ? { amount } : undefined,
        );
        print(result);
        return result.allowed ? 0 : 2;
      }
      case "consume": {
        required(flags, ["customer", "feature"], "consume --customer <id> --feature <key>");
        const key = str(flags["idempotency-key"]);
        const result = await engine.consume(
          str(flags.customer)!,
          str(flags.feature)!,
          num(flags, "amount"),
          key ? { idempotencyKey: key } : undefined,
        );
        print(result);
        return result.allowed ? 0 : 2;
      }
      case "grant": {
        required(
          flags,
          ["customer", "feature", "amount"],
          "grant --customer <id> --feature <key> --amount <n>",
        );
        const expiresAt = str(flags["expires-at"]);
        const reason = str(flags.reason);
        const recurring = bool(flags, "recurring");
        print(
          await engine.grant(
            str(flags.customer)!,
            {
              feature: str(flags.feature)!,
              amount: num(flags, "amount")!,
              ...(expiresAt ? { expiresAt } : {}),
              ...(reason ? { reason } : {}),
              ...(recurring !== undefined ? { recurring } : {}),
            },
            actor,
          ),
        );
        return 0;
      }
      case "override": {
        required(flags, ["customer", "feature"], "override --customer <id> --feature <key> …");
        const enabled = bool(flags, "enabled");
        const limitRaw = str(flags.limit);
        const limit =
          limitRaw === undefined
            ? undefined
            : limitRaw === "unlimited"
              ? null
              : num(flags, "limit");
        let value: JsonValue | undefined;
        const valueRaw = str(flags.value);
        if (valueRaw !== undefined) {
          try {
            value = JSON.parse(valueRaw) as JsonValue;
          } catch {
            throw new UsageError("Invalid --value: expected JSON (quote strings: '\"email\"').");
          }
        }
        const expiresAt = str(flags["expires-at"]);
        const reason = str(flags.reason);
        print(
          await engine.override(
            str(flags.customer)!,
            {
              feature: str(flags.feature)!,
              ...(enabled !== undefined ? { enabled } : {}),
              ...(limit !== undefined ? { limit } : {}),
              ...(value !== undefined ? { value } : {}),
              ...(expiresAt ? { expiresAt } : {}),
              ...(reason ? { reason } : {}),
            },
            actor,
          ),
        );
        return 0;
      }
      case "subscribe": {
        required(flags, ["customer", "plan"], "subscribe --customer <id> --plan <key>");
        const version = num(flags, "version");
        const quantity = num(flags, "quantity");
        const status = str(flags.status) as SubscriptionStatus | undefined;
        const trialEndsAt = str(flags["trial-ends-at"]);
        print(
          await engine.subscribe(
            str(flags.customer)!,
            {
              plan: str(flags.plan)!,
              ...(version !== undefined ? { version } : {}),
              ...(quantity !== undefined ? { quantity } : {}),
              ...(status ? { status } : {}),
              ...(trialEndsAt ? { trialEndsAt } : {}),
            },
            actor,
          ),
        );
        return 0;
      }
      case "customers": {
        const search = str(flags.search);
        const limit = num(flags, "limit");
        const page = await engine.listCustomers({
          ...(search ? { search } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        if (flags.json === true) {
          print(page);
          return 0;
        }
        if (page.customers.length === 0) process.stdout.write("No customers.\n");
        for (const c of page.customers) {
          const who = [c.name, c.email].filter(Boolean).join(" · ");
          process.stdout.write(
            `${c.id}  [${c.plans.join(", ") || "—"}]${who ? `  ${who}` : ""}  (${c.statuses.join(", ") || "no subscriptions"})\n`,
          );
        }
        if (page.next) process.stdout.write(`… more (next: ${page.next})\n`);
        return 0;
      }
      case "sweep": {
        print(await engine.sweep());
        return 0;
      }
    }
    return 1;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await engine?.close().catch(() => {});
  }
}

/** The `serve` command: panel + API on `PORT`; never resolves while serving. */
async function serve(input: {
  catalog: AnyCatalog;
  storage: EntitlementsStorage;
  counters: CounterStore;
  storageDriver: StorageDriver;
  chosenCounters: CountersDriver;
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const { flags } = input;
  const portFlag = str(flags.port);
  const portalSecret = env("PORTAL_SECRET");
  const sweep = env("SWEEP_INTERVAL", "1m");

  const { createFetchHandler } = await import("./server/create-fetch-handler.ts");
  const { DEFAULT_ROLE_POLICY } = await import("./authorization/roles.ts");
  const { isMutatingAction } = await import("./authorization/contract.ts");
  const { auth, authorization } = await buildAuthFromEnv({
    realm: "xtandard-entitlements",
    roles: { policy: DEFAULT_ROLE_POLICY, actions: { isMutatingAction } },
    name: "xtandard/entitlements",
  });

  return await kitServe({
    name: "xtandard/entitlements",
    ...(portFlag ? { port: Number(portFlag) } : {}),
    buildPanel: async ({ basePath, title, logoUrl, readonly }) =>
      createFetchHandler({
        catalog: input.catalog,
        storage: input.storage,
        counters: input.counters,
        basePath,
        title: title ?? "@xtandard/entitlements",
        ...(logoUrl ? { logoUrl } : {}),
        readonly,
        auth,
        authorization,
        ...(portalSecret ? { portal: { secret: portalSecret } } : {}),
        ...(sweep !== "0" ? { sweepInterval: sweep as Duration } : {}),
      }),
    banner: async () => [
      `storage: ${await describeStorage(STORAGE_ROLE, {
        env: withDriver(STORAGE_ROLE, input.storageDriver),
        allowed: STORAGE_DRIVERS,
      })} · counters: ${input.chosenCounters}`,
    ],
  });
}

// Run when executed directly (`bun src/cli.ts`, `node dist/cli.mjs`); the bin
// wrapper, the standalone app and tests import `run` instead.
if (isMainModule({ url: import.meta.url })) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
