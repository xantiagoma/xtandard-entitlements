/**
 * Optional usage export (ADR 0007, 0015): forward the engine's `onUsage` tap
 * to a provider meter (`provider.reportUsage`) — Stripe meter events, Polar
 * event ingestion. Best-effort and off the decision path: records are batched
 * in memory and flushed by size or interval; a failed flush is reported, not
 * retried forever (the provider stays the system of record for money).
 *
 * @example
 * ```ts
 * import { createUsageExporter } from "@xtandard/entitlements/billing";
 *
 * const exporter = createUsageExporter(stripe, { meters: { api_calls: "api_requests" } });
 * const ent = createEntitlements({ catalog, onUsage: exporter.onUsage });
 * exporter.attach(ent); // lets records carry the provider customer id
 * ```
 *
 * @module
 */

import { durationToMs, type Duration } from "../duration.ts";
import type { Entitlements } from "../engine.ts";
import type { UsageEvent, UsageListener } from "../events.ts";
import { newId } from "../id.ts";
import type { BillingProvider, UsageRecord } from "./contract.ts";

/** Options for {@link createUsageExporter}. */
export interface UsageExporterOptions {
  /** Feature key → provider meter / event name. Features not listed are not exported. */
  meters: Record<string, string>;
  /** Flush when this many records are buffered (default `100`) or every `interval` (default `"5s"`). */
  batch?: { size?: number; interval?: Duration };
  /**
   * Usage sources to export. Default `["consume", "reserve", "settle"]`
   * (positive amounts only — refunds and capacity `set`s are not meter events).
   */
  sources?: readonly UsageEvent["source"][];
  /** A flush failed; the batch is dropped. Default `console.warn`. */
  onError?: (error: unknown, records: UsageRecord[]) => void;
}

/** What {@link createUsageExporter} returns. */
export interface UsageExporter {
  /** Pass as the engine's `onUsage` option (or call from your own listener). */
  readonly onUsage: UsageListener;
  /** Give the exporter the engine so records carry `providerCustomer` (from the customer's links). */
  attach(engine: Entitlements): void;
  /** Report everything buffered now. */
  flush(): Promise<void>;
  /** Flush and stop the timer. */
  close(): Promise<void>;
  /** Records currently buffered. */
  readonly pending: number;
}

/** Export usage from `onUsage` to `provider.reportUsage`, batched. */
export function createUsageExporter(
  provider: BillingProvider,
  options: UsageExporterOptions,
): UsageExporter {
  if (typeof provider.reportUsage !== "function") {
    throw new Error(`Billing provider "${provider.id}" cannot report usage`);
  }
  const size = Math.max(1, options.batch?.size ?? 100);
  const interval = durationToMs(options.batch?.interval ?? "5s");
  const sources = new Set(options.sources ?? ["consume", "reserve", "settle"]);
  const onError =
    options.onError ??
    ((error: unknown, records: UsageRecord[]) =>
      console.warn(
        `[@xtandard/entitlements] usage export to ${provider.id} failed (${records.length} records dropped):`,
        error,
      ));
  let engine: Entitlements | undefined;
  let buffer: UsageRecord[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushing: Promise<void> = Promise.resolve();

  const startTimer = () => {
    if (timer || interval <= 0) return;
    timer = setInterval(() => void exporter.flush(), interval);
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  async function send(records: UsageRecord[]): Promise<void> {
    try {
      if (engine) {
        const links = new Map<string, string | undefined>();
        for (const r of records) {
          if (!links.has(r.customer)) {
            const state = await engine.getCustomer(r.customer);
            links.set(r.customer, state?.providers[provider.id]);
          }
          const pc = links.get(r.customer);
          if (pc) r.providerCustomer = pc;
        }
      }
      await provider.reportUsage!(records);
    } catch (error) {
      onError(error, records);
    }
  }

  const exporter: UsageExporter = {
    onUsage(event) {
      const meter = options.meters[event.feature];
      if (!meter || !sources.has(event.source) || !(event.amount > 0)) return;
      if (event.result.duplicate) return;
      buffer.push({
        customer: event.customer,
        feature: event.feature,
        meter,
        amount: event.amount,
        at: event.at,
        idempotencyKey: event.idempotencyKey
          ? `${event.customer}:${event.feature}:${event.idempotencyKey}`
          : newId("use", Date.parse(event.at)),
      });
      startTimer();
      if (buffer.length >= size) void exporter.flush();
    },
    attach(e) {
      engine = e;
    },
    flush() {
      const records = buffer;
      buffer = [];
      flushing = flushing.then(() => (records.length ? send(records) : undefined));
      return flushing;
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await exporter.flush();
    },
    get pending() {
      return buffer.length;
    },
  };
  return exporter;
}
