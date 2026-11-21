/**
 * Tiny helpers the `src/demo.ts` scripts share: numbered steps, assertions
 * that fail the demo (exit 1) with a readable message, and a JSON request
 * helper for in-process `fetch` handlers. No test framework — a demo is a
 * script you can read top to bottom.
 */

let n = 0;

/** Print a numbered step heading. */
export function step(title: string): void {
  n += 1;
  console.log(`\n${n}. ${title}`);
}

/** Print an indented detail line. */
export function info(message: string, value?: unknown): void {
  console.log(`   ${message}${value === undefined ? "" : ` ${JSON.stringify(value)}`}`);
}

/** Assert `condition`; print a check mark, or throw with `message`. */
export function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`✗ ${message}`);
  console.log(`   ✓ ${message}`);
}

/** Assert `actual === expected` (deep for plain JSON values). */
export function equal<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`✗ ${message}: expected ${e}, got ${a}`);
  console.log(`   ✓ ${message} (${a})`);
}

/** Anything that answers web `Request`s: a panel's `fetch`, `app.fetch`, `app.handle`, … */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** Call `handler` with a JSON request; return the status and parsed JSON body. */
export async function call<T = Record<string, unknown>>(
  handler: FetchHandler,
  method: string,
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  const headers = new Headers(options.headers);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const response = await handler(
    new Request(new URL(url, "http://localhost"), { method, headers, body }),
  );
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON — return the text
  }
  return { status: response.status, body: parsed as T };
}

/** Run a demo: print a banner, run `main`, exit 0 on success and 1 on failure. */
export function runDemo(title: string, main: () => Promise<void>): void {
  console.log(`▶ ${title}`);
  main().then(
    () => {
      console.log("\n✔ demo complete");
      process.exit(0);
    },
    (error: unknown) => {
      console.error(`\n${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && !error.message.startsWith("✗")) console.error(error.stack);
      process.exit(1);
    },
  );
}
