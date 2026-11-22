import { describe, expect, test } from "vitest";
import type { Principal } from "../src/auth/contract.ts";
import {
  ALL_ACTIONS,
  isMutatingAction,
  MUTATING_ACTIONS,
  PORTAL_ACTIONS,
  type EntitlementsAction,
} from "../src/authorization/contract.ts";
import {
  BILLING_ADMIN_ACTIONS,
  DEFAULT_ROLE_POLICY,
  READ_ACTIONS,
  rolesAuthorization,
  RUNTIME_SERVICE_ACTIONS,
  SUPPORT_ACTIONS,
} from "../src/authorization/roles.ts";

const request = new Request("http://localhost/");
const input = (principal: Principal | null, action: EntitlementsAction) => ({
  principal,
  action,
  resource: { type: "customer" as const, customer: "org_1" },
  request,
});
const allowedFor = async (roles: string[], authz = rolesAuthorization()) => {
  const out: EntitlementsAction[] = [];
  for (const action of ALL_ACTIONS) {
    if (await authz.authorize(input({ id: "u", roles }, action))) out.push(action);
  }
  return out;
};

describe("action set", () => {
  test("mutating actions are the control-plane writes", () => {
    expect([...MUTATING_ACTIONS].sort()).toEqual(
      [
        "customer:delete",
        "customer:update",
        "grant:write",
        "override:write",
        "subscription:write",
        "usage:write",
      ].sort(),
    );
    expect(isMutatingAction("runtime:consume")).toBe(false);
    expect(isMutatingAction("portal:checkout")).toBe(false);
    expect(isMutatingAction("grant:write")).toBe(true);
    expect(PORTAL_ACTIONS).toEqual(["portal:read", "portal:checkout", "portal:manage"]);
    expect(ALL_ACTIONS).toHaveLength(15);
  });

  test("read actions exclude the portal", () => {
    expect(READ_ACTIONS).toEqual(["catalog:read", "customer:read", "usage:read", "activity:read"]);
  });
});

describe("rolesAuthorization presets", () => {
  test("viewer reads only", async () => {
    expect(await allowedFor(["viewer"])).toEqual([...READ_ACTIONS]);
  });

  test("support / billing-admin / runtime-service", async () => {
    expect((await allowedFor(["support"])).sort()).toEqual([...SUPPORT_ACTIONS].sort());
    expect((await allowedFor(["billing-admin"])).sort()).toEqual([...BILLING_ADMIN_ACTIONS].sort());
    expect((await allowedFor(["runtime-service"])).sort()).toEqual(
      [...RUNTIME_SERVICE_ACTIONS].sort(),
    );
    expect(await allowedFor(["support"])).not.toContain("subscription:write");
    expect(await allowedFor(["billing-admin"])).not.toContain("override:write");
  });

  test("admin is a wildcard; roles combine", async () => {
    expect(await allowedFor(["admin"])).toEqual([...ALL_ACTIONS]);
    const combined = await allowedFor(["support", "runtime-service"]);
    expect(combined).toEqual(expect.arrayContaining(["grant:write", "runtime:consume"]));
    expect(DEFAULT_ROLE_POLICY.admin).toBe("*");
  });

  test("no principal, no roles, unknown roles → deny", async () => {
    const authz = rolesAuthorization();
    expect(await authz.authorize(input(null, "catalog:read"))).toBe(false);
    expect(await authz.authorize(input({ id: "u" }, "catalog:read"))).toBe(false);
    expect(await authz.authorize(input({ id: "u", roles: [] }, "catalog:read"))).toBe(false);
    expect(await authz.authorize(input({ id: "u", roles: ["ghost"] }, "catalog:read"))).toBe(false);
  });

  test("readonly denies mutating actions even for admins", async () => {
    const admin = await allowedFor(["admin"], rolesAuthorization({ readonly: true }));
    expect(admin).not.toContain("grant:write");
    expect(admin).toContain("runtime:consume");
  });

  test("custom policy", async () => {
    const authz = rolesAuthorization({ policy: { auditor: ["activity:read"] } });
    expect(await allowedFor(["auditor"], authz)).toEqual(["activity:read"]);
    expect(await allowedFor(["admin"], authz)).toEqual([]);
  });
});
