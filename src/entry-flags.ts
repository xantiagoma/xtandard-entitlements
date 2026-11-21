/**
 * The flags bridge (ADR 0008): `entitlementsContext` (flat evaluation-context
 * attributes), `createEntitlementsHook` (an OpenFeature hook that enriches
 * every evaluation) and `createEntitlementsProvider` (an OpenFeature provider
 * over entitlements). No runtime dependency on `@openfeature/server-sdk` or
 * `@xtandard/flags`.
 *
 * @module flags
 */
export {
  createEntitlementsHook,
  createEntitlementsProvider,
  entitlementsContext,
  toOpenFeatureReason,
} from "./flags.ts";
export type {
  EntitlementsContextAttributes,
  EntitlementsContextFn,
  EntitlementsContextOptions,
  EntitlementsHookOptions,
  EntitlementsOpenFeatureProvider,
  EntitlementsProviderOptions,
} from "./flags.ts";
