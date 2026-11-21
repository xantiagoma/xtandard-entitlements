/**
 * Form validation for the admin dialogs — pure, so it is unit-tested in
 * `test/ui-lib.test.ts`. Each validator turns raw form strings into either the
 * API input or a map of field errors. The server validates again (valibot);
 * these exist to give immediate, specific feedback.
 *
 * @module
 */

import type { GrantInput, NormalizedFeature, OverrideInput } from "../types.ts";
import { dateInputToIso, isNumeric, parseAmount } from "./format.ts";

/** Field errors keyed by form field. Empty = valid. */
export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** A validation outcome: the API input, or errors. */
export type Validated<T, K extends string> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldErrors<K> };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Profile form → `PATCH /api/customers/:id` body. */
export function validateProfile(form: {
  name: string;
  email: string;
}): Validated<{ name?: string; email?: string }, "name" | "email"> {
  const errors: FieldErrors<"name" | "email"> = {};
  const name = form.name.trim();
  const email = form.email.trim();
  if (name.length > 200) errors.name = "Keep the name under 200 characters.";
  if (email && !EMAIL.test(email)) errors.email = "Enter a valid email address.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, email } };
}

/** Is `iso` in the future relative to `now`? */
const future = (iso: string, now: number) => Date.parse(iso) > now;

/** Grant form fields (raw strings from the dialog). */
export interface GrantForm {
  feature: string;
  amount: string;
  expiresAt: string;
  priority: string;
  recurring: boolean;
  reason: string;
}

/** Grant form → `GrantInput`. Only numeric features take grants. */
export function validateGrant(
  form: GrantForm,
  features: ReadonlyArray<Pick<NormalizedFeature, "key" | "kind">>,
  now: number = Date.now(),
): Validated<GrantInput, keyof GrantForm> {
  const errors: FieldErrors<keyof GrantForm> = {};
  const feature = features.find((f) => f.key === form.feature);
  if (!feature) errors.feature = "Choose a feature.";
  else if (!isNumeric(feature.kind))
    errors.feature = "Grants apply to metered, credits or capacity features.";
  const amount = parseAmount(form.amount);
  if (amount === null) errors.amount = "Enter an amount.";
  else if (amount <= 0) errors.amount = "The amount must be greater than zero.";
  else if (!Number.isInteger(amount) && feature?.kind === "capacity") {
    errors.amount = "Capacity grants must be whole units.";
  }
  let expiresAt: string | undefined;
  if (form.expiresAt) {
    expiresAt = dateInputToIso(form.expiresAt);
    if (!expiresAt) errors.expiresAt = "Enter a valid date.";
    else if (!future(expiresAt, now)) errors.expiresAt = "The expiry must be in the future.";
  }
  let priority = 0;
  if (form.priority.trim()) {
    const p = parseAmount(form.priority);
    if (p === null || !Number.isInteger(p)) errors.priority = "Priority is a whole number.";
    else priority = p;
  }
  if (form.reason.length > 500) errors.reason = "Keep the reason under 500 characters.";
  if (Object.keys(errors).length) return { ok: false, errors };
  const value: GrantInput = { feature: form.feature, amount: amount!, priority };
  if (form.recurring) value.recurring = true;
  if (expiresAt) value.expiresAt = expiresAt;
  if (form.reason.trim()) value.reason = form.reason.trim();
  return { ok: true, value };
}

/** What an override does. */
export type OverrideMode = "enable" | "disable" | "limit" | "unlimited" | "value";

/** Override form fields (raw strings from the dialog). */
export interface OverrideForm {
  feature: string;
  mode: OverrideMode;
  limit: string;
  value: string;
  expiresAt: string;
  reason: string;
}

/** The override modes that make sense for a feature kind. */
export function overrideModes(kind: string): OverrideMode[] {
  if (kind === "boolean") return ["enable", "disable"];
  if (kind === "value") return ["value", "disable"];
  return ["limit", "unlimited", "enable", "disable"];
}

/** Override form → `OverrideInput`. A reason is required (it is an exception). */
export function validateOverride(
  form: OverrideForm,
  features: ReadonlyArray<Pick<NormalizedFeature, "key" | "kind">>,
  now: number = Date.now(),
): Validated<OverrideInput, keyof OverrideForm> {
  const errors: FieldErrors<keyof OverrideForm> = {};
  const feature = features.find((f) => f.key === form.feature);
  if (!feature) errors.feature = "Choose a feature.";
  else if (!overrideModes(feature.kind).includes(form.mode)) {
    errors.mode = "This kind of override does not apply to that feature.";
  }
  const value: OverrideInput = { feature: form.feature };
  switch (form.mode) {
    case "enable":
      value.enabled = true;
      break;
    case "disable":
      value.enabled = false;
      break;
    case "unlimited":
      value.limit = null;
      break;
    case "limit": {
      const n = parseAmount(form.limit);
      if (n === null) errors.limit = "Enter a limit.";
      else if (n < 0) errors.limit = "The limit cannot be negative.";
      else value.limit = n;
      break;
    }
    case "value": {
      const raw = form.value.trim();
      if (!raw) {
        errors.value = "Enter a value.";
        break;
      }
      try {
        value.value = JSON.parse(raw);
      } catch {
        value.value = raw; // plain strings need no quotes
      }
      break;
    }
  }
  if (form.expiresAt) {
    const iso = dateInputToIso(form.expiresAt);
    if (!iso) errors.expiresAt = "Enter a valid date.";
    else if (!future(iso, now)) errors.expiresAt = "The expiry must be in the future.";
    else value.expiresAt = iso;
  }
  if (!form.reason.trim()) errors.reason = "Say why — overrides are exceptions and are audited.";
  else if (form.reason.length > 500) errors.reason = "Keep the reason under 500 characters.";
  else value.reason = form.reason.trim();
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/** Set-usage form → the new counter value. */
export function validateUsage(raw: string): Validated<number, "value"> {
  const n = parseAmount(raw);
  if (n === null) return { ok: false, errors: { value: "Enter a number." } };
  if (n < 0) return { ok: false, errors: { value: "Usage cannot be negative." } };
  return { ok: true, value: n };
}

/** Trial form → `{ plan, days }`. */
export function validateTrial(form: {
  plan: string;
  days: string;
}): Validated<{ plan: string; days?: number }, "plan" | "days"> {
  const errors: FieldErrors<"plan" | "days"> = {};
  if (!form.plan) errors.plan = "Choose a plan.";
  let days: number | undefined;
  if (form.days.trim()) {
    const n = parseAmount(form.days);
    if (n === null || !Number.isInteger(n) || n < 1 || n > 365) {
      errors.days = "Between 1 and 365 days.";
    } else days = n;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: days === undefined ? { plan: form.plan } : { plan: form.plan, days } };
}
