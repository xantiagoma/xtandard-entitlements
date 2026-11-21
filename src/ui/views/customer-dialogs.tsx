import React from "react";
import { addGrant, addOverride, setUsage, startTrial, subscribe, updateCustomer } from "../api.ts";
import { useCustomerAction } from "../lib/mutations.ts";
import {
  overrideModes,
  validateGrant,
  validateOverride,
  validateProfile,
  validateTrial,
  validateUsage,
  type FieldErrors,
  type GrantForm,
  type OverrideForm,
  type OverrideMode,
} from "../lib/validate.ts";
import { formatPrice, isNumeric, limitLabel } from "../lib/format.ts";
import { CheckboxField, Field, fieldIds, FormDialog, NativeSelect } from "../components/form.tsx";
import { TextArea, TextInput } from "../components/primitives.tsx";
import type { CatalogView, CustomerState, FeatureUsage, NormalizedFeature } from "../types.ts";

interface DialogProps {
  customer: string;
  open: boolean;
  onClose: () => void;
}

/* ─── Edit profile ──────────────────────────────────────────────────────────── */

export function EditProfileDialog({
  customer,
  open,
  onClose,
  state,
}: DialogProps & { state: CustomerState | null }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [errors, setErrors] = React.useState<FieldErrors<"name" | "email">>({});
  React.useEffect(() => {
    if (open) {
      setName(state?.name ?? "");
      setEmail(state?.email ?? "");
      setErrors({});
    }
  }, [open, state]);
  const save = useCustomerAction(
    customer,
    (v: { name?: string; email?: string }) => updateCustomer(customer, v),
    {
      success: "Profile saved",
      error: "Could not save the profile",
      onSuccess: onClose,
    },
  );
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Edit profile"
      description="Display name and billing email, shown in the admin and the portal."
      submitLabel="Save profile"
      loading={save.isPending}
      onSubmit={() => {
        const r = validateProfile({ name, email });
        if (!r.ok) return setErrors(r.errors);
        setErrors({});
        save.mutate(r.value);
      }}
    >
      <Field label="Name" htmlFor="profile-name" error={errors.name}>
        <TextInput
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc."
          autoFocus
          {...fieldIds("profile-name", errors.name)}
        />
      </Field>
      <Field label="Email" htmlFor="profile-email" error={errors.email}>
        <TextInput
          id="profile-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="billing@acme.com"
          {...fieldIds("profile-email", errors.email)}
        />
      </Field>
    </FormDialog>
  );
}

/* ─── Change plan ───────────────────────────────────────────────────────────── */

export function ChangePlanDialog({
  customer,
  open,
  onClose,
  catalog,
  currentPlan,
}: DialogProps & { catalog: CatalogView; currentPlan?: string }) {
  const plans = catalog.plans.filter((p) => p.current);
  const [plan, setPlan] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setPlan(plans.find((p) => p.key !== currentPlan)?.key ?? "");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentPlan]);
  const change = useCustomerAction(
    customer,
    (key: string) => subscribe(customer, { plan: key, replace: true }),
    {
      success: (key) => `Moved to ${plans.find((p) => p.key === key)?.name ?? key}`,
      error: "Could not change the plan",
      onSuccess: onClose,
    },
  );
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Change plan"
      description="Starts a manual subscription to the plan's current version and cancels the customer's other manual subscriptions in its group."
      submitLabel="Change plan"
      loading={change.isPending}
      onSubmit={() => {
        if (!plan) return setError("Choose a plan.");
        if (plan === currentPlan) return setError("The customer is already on this plan.");
        setError(null);
        change.mutate(plan);
      }}
    >
      <Field label="Plan" htmlFor="change-plan" error={error}>
        <NativeSelect
          id="change-plan"
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          {...fieldIds("change-plan", error)}
        >
          {plans.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} — {formatPrice(p.price)}
              {p.key === currentPlan ? " (current)" : ""}
              {p.hidden ? " (hidden)" : ""}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </FormDialog>
  );
}

/* ─── Start trial ───────────────────────────────────────────────────────────── */

export function StartTrialDialog({
  customer,
  open,
  onClose,
  catalog,
  usedTrials,
}: DialogProps & { catalog: CatalogView; usedTrials: Record<string, string> }) {
  const plans = catalog.plans.filter((p) => p.current && !p.default);
  const [plan, setPlan] = React.useState("");
  const [days, setDays] = React.useState("");
  const [force, setForce] = React.useState(false);
  const [errors, setErrors] = React.useState<FieldErrors<"plan" | "days">>({});
  React.useEffect(() => {
    if (open) {
      const first = plans.find((p) => p.trialDays) ?? plans[0];
      setPlan(first?.key ?? "");
      setDays("");
      setForce(false);
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const selected = plans.find((p) => p.key === plan);
  const alreadyTrialed = plan ? usedTrials[plan] : undefined;
  const trial = useCustomerAction(
    customer,
    (v: { plan: string; days?: number; force?: boolean }) => startTrial(customer, v),
    {
      success: (v) => `Trial of ${plans.find((p) => p.key === v.plan)?.name ?? v.plan} started`,
      error: "Could not start the trial",
      onSuccess: onClose,
    },
  );
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Start trial"
      description="A trialing subscription; access ends when the trial does unless the customer subscribes."
      submitLabel="Start trial"
      loading={trial.isPending}
      onSubmit={() => {
        const r = validateTrial({ plan, days });
        if (!r.ok) return setErrors(r.errors);
        setErrors({});
        trial.mutate(force ? { ...r.value, force: true } : r.value);
      }}
    >
      <Field label="Plan" htmlFor="trial-plan" error={errors.plan}>
        <NativeSelect id="trial-plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
          {plans.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
              {p.trialDays ? ` — ${p.trialDays}-day trial` : ""}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field
        label="Length (days)"
        htmlFor="trial-days"
        error={errors.days}
        hint={
          selected?.trialDays
            ? `Leave empty for the plan's ${selected.trialDays} days.`
            : "This plan defines no trial length — set one."
        }
      >
        <TextInput
          id="trial-days"
          inputMode="numeric"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          placeholder={selected?.trialDays ? String(selected.trialDays) : "14"}
          {...fieldIds("trial-days", errors.days)}
        />
      </Field>
      {alreadyTrialed ? (
        <CheckboxField
          id="trial-force"
          checked={force}
          onChange={setForce}
          label="Allow a second trial"
          description="This customer already trialed this plan; one trial per plan unless forced."
        />
      ) : null}
    </FormDialog>
  );
}

/* ─── Grant ─────────────────────────────────────────────────────────────────── */

const EMPTY_GRANT: GrantForm = {
  feature: "",
  amount: "",
  expiresAt: "",
  priority: "",
  recurring: false,
  reason: "",
};

export function GrantDialog({
  customer,
  open,
  onClose,
  features,
  initialFeature,
}: DialogProps & { features: NormalizedFeature[]; initialFeature?: string }) {
  const numeric = features.filter((f) => isNumeric(f.kind));
  const [form, setForm] = React.useState<GrantForm>(EMPTY_GRANT);
  const [errors, setErrors] = React.useState<FieldErrors<keyof GrantForm>>({});
  React.useEffect(() => {
    if (open) {
      setForm({ ...EMPTY_GRANT, feature: initialFeature ?? numeric[0]?.key ?? "" });
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFeature]);
  const set = <K extends keyof GrantForm>(k: K, v: GrantForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const feature = numeric.find((f) => f.key === form.feature);
  const grant = useCustomerAction(
    customer,
    (v: Parameters<typeof addGrant>[1]) => addGrant(customer, v),
    {
      success: (v) =>
        `Granted ${limitLabel(feature ?? {}, v.amount)} of ${feature?.name ?? v.feature}`,
      error: "Could not add the grant",
      onSuccess: onClose,
    },
  );
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Add grant"
      description="Extra balance for a metered, credits or capacity feature — consumed after the plan's allowance."
      submitLabel="Add grant"
      loading={grant.isPending}
      onSubmit={() => {
        const r = validateGrant(form, features);
        if (!r.ok) return setErrors(r.errors);
        setErrors({});
        grant.mutate(r.value);
      }}
    >
      <Field label="Feature" htmlFor="grant-feature" error={errors.feature}>
        <NativeSelect
          id="grant-feature"
          value={form.feature}
          onChange={(e) => set("feature", e.target.value)}
          {...fieldIds("grant-feature", errors.feature)}
        >
          {numeric.map((f) => (
            <option key={f.key} value={f.key}>
              {f.name} ({f.kind})
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Amount"
          htmlFor="grant-amount"
          error={errors.amount}
          hint={feature?.units ?? feature?.unit}
        >
          <TextInput
            id="grant-amount"
            inputMode="decimal"
            value={form.amount}
            onChange={(e) => set("amount", e.target.value)}
            placeholder="1,000"
            autoFocus
            {...fieldIds("grant-amount", errors.amount)}
          />
        </Field>
        <Field
          label="Priority"
          htmlFor="grant-priority"
          error={errors.priority}
          hint="Lower is consumed first"
        >
          <TextInput
            id="grant-priority"
            inputMode="numeric"
            value={form.priority}
            onChange={(e) => set("priority", e.target.value)}
            placeholder="0"
            {...fieldIds("grant-priority", errors.priority)}
          />
        </Field>
      </div>
      <Field
        label="Expires"
        htmlFor="grant-expires"
        error={errors.expiresAt}
        hint="Optional. End of day, UTC."
      >
        <TextInput
          id="grant-expires"
          type="date"
          value={form.expiresAt}
          onChange={(e) => set("expiresAt", e.target.value)}
          {...fieldIds("grant-expires", errors.expiresAt)}
        />
      </Field>
      <CheckboxField
        id="grant-recurring"
        checked={form.recurring}
        onChange={(v) => set("recurring", v)}
        label="Recurring"
        description="Adds the amount to every period's allowance instead of a one-off balance."
      />
      <Field label="Reason" htmlFor="grant-reason" error={errors.reason}>
        <TextArea
          id="grant-reason"
          rows={2}
          value={form.reason}
          onChange={(e) => set("reason", e.target.value)}
          placeholder="Goodwill credit for the March incident"
          {...fieldIds("grant-reason", errors.reason)}
        />
      </Field>
    </FormDialog>
  );
}

/* ─── Override ──────────────────────────────────────────────────────────────── */

const MODE_LABEL: Record<OverrideMode, string> = {
  enable: "Force enable",
  disable: "Disable",
  limit: "Set limit",
  unlimited: "Unlimited",
  value: "Set value",
};

export function OverrideDialog({
  customer,
  open,
  onClose,
  features,
  initialFeature,
}: DialogProps & { features: NormalizedFeature[]; initialFeature?: string }) {
  const blank = (feature: string): OverrideForm => {
    const kind = features.find((f) => f.key === feature)?.kind ?? "boolean";
    return {
      feature,
      mode: overrideModes(kind)[0]!,
      limit: "",
      value: "",
      expiresAt: "",
      reason: "",
    };
  };
  const [form, setForm] = React.useState<OverrideForm>(() => blank(""));
  const [errors, setErrors] = React.useState<FieldErrors<keyof OverrideForm>>({});
  React.useEffect(() => {
    if (open) {
      setForm(blank(initialFeature ?? features[0]?.key ?? ""));
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFeature]);
  const set = <K extends keyof OverrideForm>(k: K, v: OverrideForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const feature = features.find((f) => f.key === form.feature);
  const modes = overrideModes(feature?.kind ?? "boolean");
  const add = useCustomerAction(
    customer,
    (v: Parameters<typeof addOverride>[1]) => addOverride(customer, v),
    {
      success: (v) =>
        `Override on ${features.find((f) => f.key === v.feature)?.name ?? v.feature} added`,
      error: "Could not add the override",
      onSuccess: onClose,
    },
  );
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Add override"
      description="An operator exception for one feature. It replaces what the plan, add-ons and grants resolve to."
      submitLabel="Add override"
      loading={add.isPending}
      onSubmit={() => {
        const r = validateOverride(form, features);
        if (!r.ok) return setErrors(r.errors);
        setErrors({});
        add.mutate(r.value);
      }}
    >
      <Field label="Feature" htmlFor="override-feature" error={errors.feature}>
        <NativeSelect
          id="override-feature"
          value={form.feature}
          onChange={(e) => {
            const next = blank(e.target.value);
            setForm((f) => ({ ...next, reason: f.reason, expiresAt: f.expiresAt }));
          }}
        >
          {features.map((f) => (
            <option key={f.key} value={f.key}>
              {f.name} ({f.kind})
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Override" htmlFor="override-mode" error={errors.mode}>
        <NativeSelect
          id="override-mode"
          value={form.mode}
          onChange={(e) => set("mode", e.target.value as OverrideMode)}
        >
          {modes.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {form.mode === "limit" ? (
        <Field
          label="Limit"
          htmlFor="override-limit"
          error={errors.limit}
          hint={feature?.units ?? feature?.unit}
        >
          <TextInput
            id="override-limit"
            inputMode="decimal"
            value={form.limit}
            onChange={(e) => set("limit", e.target.value)}
            placeholder="50,000"
            {...fieldIds("override-limit", errors.limit)}
          />
        </Field>
      ) : null}
      {form.mode === "value" ? (
        <Field
          label="Value"
          htmlFor="override-value"
          error={errors.value}
          hint="JSON, or plain text for a string."
        >
          <TextInput
            id="override-value"
            value={form.value}
            onChange={(e) => set("value", e.target.value)}
            placeholder={JSON.stringify(feature?.default ?? "")}
            {...fieldIds("override-value", errors.value)}
          />
        </Field>
      ) : null}
      <Field
        label="Expires"
        htmlFor="override-expires"
        error={errors.expiresAt}
        hint="Optional. End of day, UTC."
      >
        <TextInput
          id="override-expires"
          type="date"
          value={form.expiresAt}
          onChange={(e) => set("expiresAt", e.target.value)}
          {...fieldIds("override-expires", errors.expiresAt)}
        />
      </Field>
      <Field label="Reason" htmlFor="override-reason" error={errors.reason}>
        <TextArea
          id="override-reason"
          rows={2}
          value={form.reason}
          onChange={(e) => set("reason", e.target.value)}
          placeholder="Enterprise pilot — sales approved"
          {...fieldIds("override-reason", errors.reason)}
        />
      </Field>
    </FormDialog>
  );
}

/* ─── Set usage ─────────────────────────────────────────────────────────────── */

export function SetUsageDialog({
  customer,
  open,
  onClose,
  feature,
  usage,
}: DialogProps & { feature: NormalizedFeature | null; usage?: FeatureUsage }) {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setValue(String(usage?.used ?? 0));
      setError(null);
    }
  }, [open, usage]);
  const save = useCustomerAction(customer, (v: number) => setUsage(customer, feature!.key, v), {
    success: (v) => `${feature?.name ?? "Usage"} set to ${v.toLocaleString("en-US")}`,
    error: "Could not set usage",
    onSuccess: onClose,
  });
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Set usage — ${feature?.name ?? ""}`}
      description={
        feature?.kind === "capacity"
          ? "The number of units in use right now (e.g. seats)."
          : "Replaces this period's counter. Use it to correct metering, not to grant balance."
      }
      submitLabel="Set usage"
      loading={save.isPending}
      onSubmit={() => {
        const r = validateUsage(value);
        if (!r.ok) return setError(r.errors.value ?? "Invalid");
        setError(null);
        save.mutate(r.value);
      }}
    >
      <Field
        label="Used"
        htmlFor="usage-value"
        error={error}
        hint={
          usage?.limit === undefined
            ? undefined
            : `Limit: ${limitLabel(feature ?? {}, usage.limit)}`
        }
      >
        <TextInput
          id="usage-value"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          {...fieldIds("usage-value", error)}
        />
      </Field>
    </FormDialog>
  );
}
