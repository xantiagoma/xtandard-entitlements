import { describe, expectTypeOf, it } from "vitest";
import { createEntitlements } from "../src/engine.ts";
import {
  defineCatalog,
  feature,
  type FeatureKey,
  type FeatureKeyOfKind,
  type PlanKey,
} from "../src/catalog.ts";
import { catalog } from "./fixtures.ts";

describe("catalog typing", () => {
  it("infers keys", () => {
    expectTypeOf<FeatureKey<typeof catalog>>().toEqualTypeOf<
      | "seats"
      | "projects"
      | "api_calls"
      | "exports"
      | "ai_credits"
      | "gpt_tokens"
      | "export_pdf"
      | "sso"
      | "max_upload_mb"
      | "support"
    >();
    expectTypeOf<PlanKey<typeof catalog>>().toEqualTypeOf<
      "free" | "pro" | "business" | "enterprise"
    >();
    expectTypeOf<FeatureKeyOfKind<typeof catalog, "boolean">>().toEqualTypeOf<
      "export_pdf" | "sso"
    >();
  });

  it("widens value features", () => {
    const f = feature.value({ default: 10 });
    expectTypeOf(f.default).toEqualTypeOf<number>();
  });

  it("rejects plan entries of the wrong kind", () => {
    defineCatalog({
      features: { a: feature.boolean(), b: feature.metered({ reset: "month" }) },
      // @ts-expect-error — boolean feature takes true/false, not a number
      plans: { p: { features: { a: 3 } } },
    });
    defineCatalog({
      features: { a: feature.boolean(), b: feature.metered({ reset: "month" }) },
      plans: { p: { features: { b: { limit: 5, overage: "allow" } } } },
    });
  });
});

describe("engine typing", () => {
  const ent = createEntitlements({ catalog });
  it("feature keys are checked", () => {
    // @ts-expect-error — unknown feature
    void ent.check("org", "exprot_pdf");
    void ent.consume("org", "api_calls", 3);
  });
  it("value features return typed values", async () => {
    const r = await ent.check("org", "max_upload_mb");
    expectTypeOf(r.value).toEqualTypeOf<number | undefined>();
    const s = await ent.customer("org").check("support");
    expectTypeOf(s.value).toEqualTypeOf<string | undefined>();
  });
});
