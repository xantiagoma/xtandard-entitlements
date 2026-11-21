/**
 * The flags bridge: one decision for "is the rollout on for this customer?"
 * AND "does their plan include it?" (ADR 0008).
 *
 *   bun run demo     # or, from the repo root: bun run examples:flags-bridge --demo
 *
 * 1. `createEntitlementsHook(ent)` — an OpenFeature hook that adds `plan`,
 *    `subscription.status` and `entitlement.*` attributes to every evaluation,
 *    so @xtandard/flags rules (or any provider's) can target them.
 * 2. `createEntitlementsProvider(ent)` — entitlements *as* flags: the flag key is
 *    a feature key, the targeting key is the customer.
 * 3. `entitlementsContext(ent)` — the same attributes for any other flags SDK.
 */
import { OpenFeature } from "@openfeature/server-sdk";
import { createEntitlements } from "@xtandard/entitlements";
import {
  createEntitlementsHook,
  createEntitlementsProvider,
  entitlementsContext,
} from "@xtandard/entitlements/flags";
import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
import { createOpenFeatureProvider } from "@xtandard/flags/openfeature";
import { booleanFlag, createTestPanel, publishFlags, variantFlag } from "@xtandard/flags/testing";
import { catalog } from "../../shared/catalog.ts";
import { equal, info, runDemo, step } from "../../shared/demo-kit.ts";
import { seedDemoCustomers } from "../../shared/seed.ts";

runDemo("Flags bridge × @xtandard/entitlements", async () => {
  const ent = createEntitlements({ catalog, storage: createMemoryStorage() });
  await seedDemoCustomers(ent);

  step("Publish @xtandard/flags rules that target plans and entitlements");
  // In production these live in the @xtandard/flags panel; an in-memory panel keeps
  // the demo self-contained.
  const { core, runtimeStorage } = createTestPanel();
  await publishFlags(core, [
    booleanFlag("new-export-ui", {
      default: false,
      rules: [
        {
          id: "can-export",
          conditions: [{ attribute: "entitlement.export_pdf", operator: "equals", value: true }],
          serve: { variant: "on" },
        },
      ],
    }),
    variantFlag("support-widget", "string", {
      variants: { none: "none", chat: "chat" },
      default: "none",
      rules: [
        {
          id: "business",
          conditions: [{ attribute: "plan", operator: "in", value: ["business"] }],
          serve: { variant: "chat" },
        },
      ],
    }),
    booleanFlag("trial-banner", {
      default: false,
      rules: [
        {
          id: "trialing",
          conditions: [{ attribute: "subscription.status", operator: "equals", value: "trialing" }],
          serve: { variant: "on" },
        },
      ],
    }),
  ]);
  info("flags: new-export-ui (entitlement.export_pdf), support-widget (plan), trial-banner");

  step("OpenFeature: the flags provider + the entitlements hook");
  await OpenFeature.setProviderAndWait(
    createOpenFeatureProvider({ storage: runtimeStorage, refreshIntervalMs: 0 }),
  );
  OpenFeature.addHooks(createEntitlementsHook(ent)); // customer = targetingKey
  const flags = OpenFeature.getClient();
  const evaluate = async (org: string) => ({
    exportUi: await flags.getBooleanValue("new-export-ui", false, { targetingKey: org }),
    widget: await flags.getStringValue("support-widget", "none", { targetingKey: org }),
    banner: await flags.getBooleanValue("trial-banner", false, { targetingKey: org }),
  });
  equal(await evaluate("org_free"), { exportUi: false, widget: "none", banner: false }, "org_free");
  equal(
    await evaluate("org_acme"),
    { exportUi: true, widget: "none", banner: false },
    "org_acme (pro)",
  );
  equal(
    await evaluate("org_globex"),
    { exportUi: true, widget: "chat", banner: false },
    "org_globex (business)",
  );
  equal(
    await evaluate("org_trial"),
    { exportUi: true, widget: "none", banner: true },
    "org_trial (pro, trialing)",
  );

  step("A plan change flips the flags — no flag edit needed");
  await ent.subscribe("org_free", { plan: "business" });
  equal(
    await evaluate("org_free"),
    { exportUi: true, widget: "chat", banner: false },
    "org_free → business",
  );

  step("Entitlements as flags: createEntitlementsProvider");
  await OpenFeature.setProviderAndWait("entitlements", createEntitlementsProvider(ent));
  const gates = OpenFeature.getClient("entitlements");
  const acme = { targetingKey: "org_acme" };
  equal(await gates.getBooleanValue("export_pdf", false, acme), true, "boolean → allowed");
  equal(await gates.getNumberValue("api_calls", 0, acme), 88_000, "number → remaining");
  equal(await gates.getNumberValue("max_upload_mb", 0, acme), 500, "number → a value feature");
  const sso = await gates.getBooleanDetails("sso", false, acme);
  equal([sso.value, sso.variant], [false, "not_in_plan"], "variant = the decision reason");
  equal(sso.flagMetadata.unlockedBy, "business", "flagMetadata carries unlockedBy");

  step("Any other flags SDK: entitlementsContext");
  const attrs = await entitlementsContext(ent, { usage: false })("org_legacy");
  equal(
    [attrs.plan, attrs["entitlement.export_pdf"], attrs["entitlement.seats.limit"]],
    ["pro", true, 5],
    "flat attributes from the memory-first snapshot (pro v1: 5 seats)",
  );

  await OpenFeature.close();
  await ent.close();
});
