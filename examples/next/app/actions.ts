"use server";
// A server action metering the same feature as /api/generate — server actions
// call the engine directly (no HTTP, no guard wrapper).
import type { CheckResult } from "@xtandard/entitlements";
import { ent, ready } from "../lib/billing.ts";

/** What the form shows after a submit. */
export type GenerateState = Pick<
  CheckResult,
  "allowed" | "reason" | "remaining" | "unlockedBy"
> | null;

/** Consume one `api_calls` for the org in the form (your session in a real app). */
export async function generate(_prev: GenerateState, form: FormData): Promise<GenerateState> {
  await ready;
  const org = String(form.get("org") ?? "");
  const { allowed, reason, remaining, unlockedBy } = await ent.consume(org, "api_calls");
  return { allowed, reason, remaining, unlockedBy };
}
