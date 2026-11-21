/**
 * Audit bridge (ADR 0013): `auditHooks(audit)` records entitlements changes
 * into `@xtandard/audit` — structural types, no runtime dependency.
 *
 * @module bridges/audit
 */
export { auditHooks } from "./bridges/audit.ts";
export type {
  AuditActorLike,
  AuditHooksOptions,
  AuditRecorderLike,
  AuditRecordInputLike,
  AuditTargetLike,
} from "./bridges/audit.ts";
