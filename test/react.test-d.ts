import { describe, expectTypeOf, it } from "vitest";
import {
  createEntitlementsReact,
  type EntitlementState,
  type GateProps,
  type UsageMeterProps,
} from "../src/react/index.tsx";
import { catalog } from "./react-fixtures.ts";

const typed = createEntitlementsReact<typeof catalog>();
type Features = "seats" | "api_calls" | "ai_credits" | "export_pdf" | "sso" | "max_upload_mb";

describe("createEntitlementsReact", () => {
  it("useEntitlement takes catalog feature keys and types value features", () => {
    expectTypeOf(typed.useEntitlement).parameter(0).toEqualTypeOf<Features>();
    expectTypeOf(typed.useEntitlement("max_upload_mb")).toEqualTypeOf<EntitlementState<number>>();
    expectTypeOf(typed.useEntitlement("seats").limit).toEqualTypeOf<number | null | undefined>();
    // @ts-expect-error — not a feature of this catalog
    typed.useEntitlement("nope");
  });

  it("Gate takes feature keys only", () => {
    expectTypeOf<Parameters<typeof typed.Gate<"sso">>[0]>().toEqualTypeOf<GateProps<"sso">>();
    // @ts-expect-error — not a feature of this catalog
    typed.Gate({ feature: "nope" });
  });

  it("UsageMeter takes numeric features only", () => {
    expectTypeOf<Parameters<typeof typed.UsageMeter<"api_calls">>[0]>().toEqualTypeOf<
      UsageMeterProps<"api_calls">
    >();
    // @ts-expect-error — boolean feature has no meter
    typed.UsageMeter({ feature: "export_pdf" });
  });

  it("PricingTable / useCustomer use plan keys", () => {
    typed.PricingTable({
      currentPlan: "pro",
      onSelect: (plan) => expectTypeOf(plan).toEqualTypeOf<"free" | "pro" | "business">(),
    });
    // @ts-expect-error — unknown plan
    typed.PricingTable({ currentPlan: "platinum" });
    expectTypeOf(typed.useCustomer().plan).toEqualTypeOf<"free" | "pro" | "business" | undefined>();
  });
});
