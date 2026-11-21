/**
 * The hooks and components, typed by the catalog: feature keys autocomplete,
 * `useEntitlement("max_upload_mb").value` is a number, `<UsageMeter>` only
 * takes numeric features and `<PricingTable onSelect>` gets a plan key.
 * Type-only import — the catalog itself never ships to the browser here.
 */
import { createEntitlementsReact } from "@xtandard/entitlements/react";
import type { Catalog } from "../../shared/catalog.ts";

export const {
  EntitlementsProvider,
  Gate,
  PricingTable,
  UpgradePrompt,
  UsageMeter,
  useCustomer,
  useEntitlement,
  useEntitlements,
} = createEntitlementsReact<Catalog>();
