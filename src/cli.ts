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

import type { AuthProvider } from "./auth/contract.ts";
import type { AuthorizationProvider } from "./authorization/contract.ts";
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

const env = (key: string, fallback = ""): string => process.env[key] || fallback;

const isTruthy = (value: string): boolean => value === "1" || value.toLowerCase() === "true";

/** The actor recorded for CLI-made control-plane changes. */
const CLI_ACTOR: Actor = { id: "cli", type: "system", name: "xtandard-entitlements CLI" };

/**
 * Import one of this package's own subpath entries (`storage-redis`,
 * `counters-postgres`, …) lazily, so optional peers load only when chosen. Run
 * from TypeScript source (tests, the standalone app) the entry is
 * `./entry-<name>.ts`; compiled, it is the sibling `./entry-<name>.mjs`.
 */
async function importEntry<T>(name: string): Promise<T> {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".mjs";
  const specifier = new URL(`./entry-${name}${ext}`, import.meta.url).href;
  try {
    return (await import(/* @vite-ignore */ specifier)) as T;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_MODULE_NOT_FOUND" || /Cannot find module/i.test(String(err))) {
      throw new Error(
        `The "${name.replace("-", "/")}" driver is not available in this build (${String(err)}).`,
      );
    }
    throw err;
  }
}

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

/**
 * Build the state storage from env (`STORAGE_DRIVER`, default `file` —
 * `./.entitlements/state`). Connection-string drivers read `REDIS_URL`,
 * `DATABASE_URL` / `POSTGRES_URL`, `MONGO_URL`, `LIBSQL_URL`, ….
 */
export async function buildStorage(driver: StorageDriver): Promise<EntitlementsStorage> {
  switch (driver) {
    case "memory": {
      const { createMemoryStorage } = await import("./storage/memory.ts");
      return createMemoryStorage();
    }
    case "redis": {
      const m = await importEntry<{ createRedisStorage(o: object): EntitlementsStorage }>(
        "storage-redis",
      );
      return m.createRedisStorage({
        url: env("REDIS_URL", "redis://localhost:6379"),
        prefix: env("STORAGE_PREFIX", "xtandard:entitlements"),
      });
    }
    case "postgres": {
      const m = await importEntry<{ createPostgresStorage(o: object): EntitlementsStorage }>(
        "storage-postgres",
      );
      return m.createPostgresStorage({
        connectionString:
          env("DATABASE_URL") || env("POSTGRES_URL", "postgres://localhost:5432/postgres"),
        table: env("STORAGE_PG_TABLE", "xtandard_entitlements_kv"),
      });
    }
    case "mongodb": {
      const m = await importEntry<{ createMongoStorage(o: object): EntitlementsStorage }>(
        "storage-mongodb",
      );
      return m.createMongoStorage({
        url: env("MONGO_URL", "mongodb://localhost:27017"),
        dbName: env("MONGO_DB", "xtandard_entitlements"),
        collectionName: env("STORAGE_MONGO_COLLECTION", "entitlements_kv"),
      });
    }
    case "sqlite": {
      // Requires running the CLI under Bun (`bunx xtandard-entitlements …`).
      const m = await importEntry<{ createSqliteStorage(o: object): EntitlementsStorage }>(
        "storage-sqlite",
      );
      return m.createSqliteStorage({
        path: env("STORAGE_SQLITE_PATH", "./.entitlements/state.sqlite"),
      });
    }
    case "libsql": {
      const m = await importEntry<{ createLibsqlStorage(o: object): EntitlementsStorage }>(
        "storage-libsql",
      );
      const authToken = env("LIBSQL_AUTH_TOKEN");
      return m.createLibsqlStorage({
        url: env("LIBSQL_URL", "file:./.entitlements/state.db"),
        ...(authToken ? { authToken } : {}),
      });
    }
    case "file":
    default: {
      const m = await importEntry<{ createFileStorage(o: object): EntitlementsStorage }>(
        "storage-file",
      );
      return m.createFileStorage({ dir: env("STORAGE_FILE_DIR", "./.entitlements/state") });
    }
  }
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
  return { counters: await counterStore(chosen, storage), driver: chosen };
}

async function counterStore(
  chosen: CountersDriver,
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
    case "redis": {
      const m = await importEntry<{ createRedisCounterStore(o: object): CounterStore }>(
        "counters-redis",
      );
      return m.createRedisCounterStore({
        url: env("REDIS_URL", "redis://localhost:6379"),
        prefix: env("COUNTERS_PREFIX", "xtandard:entitlements:counters"),
      });
    }
    case "postgres": {
      const m = await importEntry<{ createPostgresCounterStore(o: object): CounterStore }>(
        "counters-postgres",
      );
      return m.createPostgresCounterStore({
        connectionString:
          env("DATABASE_URL") || env("POSTGRES_URL", "postgres://localhost:5432/postgres"),
        ...(env("COUNTERS_PG_TABLE") ? { table: env("COUNTERS_PG_TABLE") } : {}),
      });
    }
    case "mongodb": {
      const m = await importEntry<{ createMongoCounterStore(o: object): CounterStore }>(
        "counters-mongodb",
      );
      return m.createMongoCounterStore({
        url: env("MONGO_URL", "mongodb://localhost:27017"),
        dbName: env("MONGO_DB", "xtandard_entitlements"),
        ...(env("COUNTERS_MONGO_COLLECTION")
          ? { collectionName: env("COUNTERS_MONGO_COLLECTION") }
          : {}),
      });
    }
    case "sqlite": {
      const m = await importEntry<{ createSqliteCounterStore(o: object): CounterStore }>(
        "counters-sqlite",
      );
      return m.createSqliteCounterStore({
        path: env("COUNTERS_SQLITE_PATH", "./.entitlements/counters.sqlite"),
      });
    }
    case "libsql": {
      const m = await importEntry<{ createLibsqlCounterStore(o: object): CounterStore }>(
        "counters-libsql",
      );
      const authToken = env("LIBSQL_AUTH_TOKEN");
      return m.createLibsqlCounterStore({
        url: env("COUNTERS_LIBSQL_URL") || env("LIBSQL_URL", "file:./.entitlements/counters.db"),
        ...(authToken ? { authToken } : {}),
      });
    }
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

/** A human-readable, log-safe description of where state lives (never prints URLs). */
async function describe(storage: StorageDriver, counters: string): Promise<string> {
  const { resolve } = await import("node:path");
  const where =
    storage === "file"
      ? `file → ${resolve(env("STORAGE_FILE_DIR", "./.entitlements/state"))}`
      : storage === "sqlite"
        ? `sqlite → ${resolve(env("STORAGE_SQLITE_PATH", "./.entitlements/state.sqlite"))}`
        : storage === "memory"
          ? "memory (ephemeral — not persisted)"
          : storage;
  return `storage: ${where} · counters: ${counters}`;
}

/** Build the auth + authorization providers from env (mirrors the standalone app). */
async function buildAuth(): Promise<{ auth: AuthProvider; authorization: AuthorizationProvider }> {
  const mode = env("AUTH_MODE", "none");
  if (mode === "basic") {
    const [{ basicAuth }, { rolesAuthorization }] = await Promise.all([
      import("./auth/basic.ts"),
      import("./authorization/roles.ts"),
    ]);
    const passwordHash = env("AUTH_PASSWORD_HASH");
    const password = env("AUTH_PASSWORD");
    if (!passwordHash && !password) {
      process.stderr.write(
        "[xtandard/entitlements] AUTH_MODE=basic but neither AUTH_PASSWORD_HASH nor AUTH_PASSWORD is set.\n",
      );
    }
    return {
      auth: basicAuth({
        realm: "xtandard-entitlements",
        users: [
          {
            username: env("AUTH_USERNAME", "admin"),
            ...(passwordHash ? { passwordHash } : {}),
            ...(password ? { password } : {}),
            roles: [env("AUTH_ROLE", "admin")],
          },
        ],
      }),
      authorization: rolesAuthorization({}),
    };
  }
  if (mode !== "none") throw new Error(`Unknown AUTH_MODE "${mode}" (expected none or basic)`);
  const [{ noAuth }, { noAuthorization }] = await Promise.all([
    import("./auth/none.ts"),
    import("./authorization/none.ts"),
  ]);
  return { auth: noAuth(), authorization: noAuthorization() };
}

type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * Serve a web-standard fetch handler under whatever runtime the CLI runs on:
 * `Bun.serve` under `bunx`, a `node:http` bridge under `npx` / Node. Resolves
 * once listening.
 */
async function startServer(port: number, fetch: FetchHandler): Promise<void> {
  const bun = (globalThis as { Bun?: { serve: (options: unknown) => unknown } }).Bun;
  if (bun) {
    bun.serve({ port, fetch });
    return;
  }
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const method = req.method ?? "GET";
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined) continue;
          headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        }
        const host = req.headers.host ?? `localhost:${port}`;
        const hasBody = method !== "GET" && method !== "HEAD" && chunks.length > 0;
        const response = await fetch(
          new Request(`http://${host}${req.url ?? "/"}`, {
            method,
            headers,
            body: hasBody ? Buffer.concat(chunks) : undefined,
          }),
        );
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (err) {
        res.statusCode = 500;
        res.end(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
}

/** Minimal flag/value argv parser: `--key value`, `--key=value` and `--flag`. */
export function parseArgs(argv: string[]): {
  _: string[];
  flags: Record<string, string | boolean>;
} {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else _.push(a);
  }
  return { _, flags };
}

/** Read this package's version from the nearest package.json (dist or src). */
async function pkgVersion(): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

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
  const port = Number(str(flags.port) || env("PORT", "3000"));
  const basePath = env("BASE_PATH", "");
  const title = env("TITLE", "@xtandard/entitlements");
  const logoUrl = env("LOGO_URL");
  const readonly = isTruthy(env("READONLY"));
  const portalSecret = env("PORTAL_SECRET");
  const sweep = env("SWEEP_INTERVAL", "1m");

  const { createFetchHandler } = await import("./server/create-fetch-handler.ts");
  const { auth, authorization } = await buildAuth();
  if (env("AUTH_MODE", "none") === "none") {
    process.stderr.write(
      "[xtandard/entitlements] AUTH_MODE=none — do NOT expose this publicly without authentication.\n",
    );
  }

  const panel = createFetchHandler({
    catalog: input.catalog,
    storage: input.storage,
    counters: input.counters,
    basePath,
    title,
    ...(logoUrl ? { logoUrl } : {}),
    readonly,
    auth,
    authorization,
    ...(portalSecret ? { portal: { secret: portalSecret } } : {}),
    ...(sweep !== "0" ? { sweepInterval: sweep as Duration } : {}),
  });

  process.stdout.write(
    `[xtandard/entitlements] ${await describe(input.storageDriver, input.chosenCounters)}\n`,
  );
  await startServer(port, panel.fetch);
  const normalizedBase = basePath && basePath !== "/" ? `/${basePath.replace(/^\/|\/$/g, "")}` : "";
  process.stdout.write(
    `[xtandard/entitlements] listening on http://localhost:${port}${normalizedBase || "/"}\n`,
  );
  // The server owns the process now; never resolve so the bin doesn't exit.
  return await new Promise<number>(() => {});
}
