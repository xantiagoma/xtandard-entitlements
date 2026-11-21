/**
 * The transition matrix every provider must pass (ADR 0007): trial → active →
 * past_due → upgrade / downgrade (incl. legacy price → plan v1) → add-on
 * quantity changes → cancel at period end → period passes → resubscribe →
 * out-of-order (stale) → duplicate → unknown price → canceled, plus bad and
 * expired signatures. Each step goes through `billing.handleWebhook` with a
 * signed, provider-native payload built by the driver.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { BillingVerificationError } from "../src/billing/contract.ts";
import { createBilling, type UnmappedEvent } from "../src/billing/intake.ts";
import type { EntitlementsBilling } from "../src/billing/contract.ts";
import type { Subscription } from "../src/schema.ts";
import { createTestEntitlements, type TestClock } from "../src/testing.ts";
import { billingCatalog, type Driver, type SubState } from "./billing-fixtures.ts";

const DAY = 86_400_000;

export function runTransitionMatrix(name: string, makeDriver: (now: () => number) => Driver) {
  describe(`${name} transition matrix`, () => {
    const customer = "org_acme";
    let clock: TestClock;
    let ent: ReturnType<typeof createTestEntitlements<typeof billingCatalog>>["ent"];
    let billing: EntitlementsBilling;
    let driver: Driver;
    const unmapped: UnmappedEvent[] = [];
    let seq = 0;
    let state: SubState;
    let addon: SubState | undefined;
    const pc = name === "lemonsqueezy" ? "4242" : `cus_${name}_1`;
    const ref = (n: number) => (name === "lemonsqueezy" ? String(500 + n) : `sub_${name}_${n}`);

    const iso = (offsetMs = 0) => new Date(clock.now() + offsetMs).toISOString();
    const send = async (s: SubState, o: { deleted?: boolean; eventId?: string } = {}) => {
      const eventId = o.eventId ?? `evt_${name}_${++seq}`;
      return billing.handleWebhook(name, await driver.webhook(s, { eventId, ...o }));
    };
    const step = (patch: Partial<SubState>, s: SubState = state): SubState => {
      clock.advance("1m");
      return { ...s, updatedAt: iso(), ...patch };
    };
    const subs = async (): Promise<Subscription[]> =>
      (await ent.getCustomer(customer))?.subscriptions ?? [];
    const planSub = async (r = state.ref) => (await subs()).find((s) => s.providerRef === r);
    const plans = async () =>
      (await ent.resolve(customer)).plans.map((p) => `${p.plan}@${p.version}`);

    beforeAll(() => {
      const t = createTestEntitlements({ catalog: billingCatalog, now: "2026-11-20T10:00:00Z" });
      clock = t.clock;
      ent = t.ent;
      driver = makeDriver(clock.now);
      billing = createBilling(ent, {
        now: clock.now,
        providers: [driver.provider],
        onUnmapped: (e) => void unmapped.push(e),
      });
      state = {
        ref: ref(1),
        providerCustomer: pc,
        customer,
        status: "trialing",
        items: [{ id: driver.ids.pro, quantity: 1 }],
        periodStart: iso(),
        periodEnd: iso(14 * DAY),
        trialEnd: iso(14 * DAY),
        updatedAt: iso(),
      };
    });

    test("trial starts: pro (current version), trialing, linked customer", async () => {
      expect(await send(state)).toEqual({ outcome: "applied", events: 1 });
      const sub = await planSub();
      expect(sub).toMatchObject({ plan: "pro", version: 2, kind: "plan", status: "trialing" });
      expect(sub!.provider).toBe(name);
      expect(sub!.trialEndsAt).toBe(state.trialEnd);
      expect(await ent.resolveLink(name, pc)).toBe(customer);
      expect((await ent.check(customer, "export_pdf")).allowed).toBe(true);
    });

    test("trial converts: active (customer resolved through the link table)", async () => {
      state = step({ status: "active", customer: undefined, trialEnd: undefined });
      expect((await send(state)).outcome).toBe("applied");
      expect((await planSub())!.status).toBe("active");
    });

    test("payment fails: past_due stays entitled", async () => {
      state = step({ status: "past_due" });
      expect((await send(state)).outcome).toBe("applied");
      expect((await planSub())!.status).toBe("past_due");
      expect(await plans()).toContain("pro@2");
    });

    test("upgrade: a business price on the same subscription switches the plan", async () => {
      const before = await planSub();
      state = step({ status: "active", items: [{ id: driver.ids.business, quantity: 1 }] });
      expect((await send(state)).outcome).toBe("applied");
      const after = await planSub();
      expect(after).toMatchObject({ id: before!.id, plan: "business", version: 1 });
      expect((await ent.check(customer, "sso")).allowed).toBe(true);
    });

    test("downgrade to a legacy price pins the old plan version", async () => {
      state = step({ items: [{ id: driver.ids.legacy, quantity: 1 }] });
      expect((await send(state)).outcome).toBe("applied");
      expect(await planSub()).toMatchObject({ plan: "pro", version: 1 });
      expect(await plans()).toEqual(["pro@1"]);
      expect((await ent.check(customer, "seats")).limit).toBe(5);
    });

    test("add-on bought with quantity 2, then 3", async () => {
      const seats = (q: number) => ({ id: driver.ids.seats, quantity: q, itemRef: "si_seats" });
      if (driver.multiItem) {
        state = step({ items: [{ id: driver.ids.legacy, quantity: 1 }, seats(2)] });
        expect((await send(state)).outcome).toBe("applied");
      } else {
        addon = step({ ref: ref(2), items: [seats(2)], status: "active" });
        expect((await send(addon)).outcome).toBe("applied");
      }
      const addonSub = async () => (await subs()).find((s) => s.kind === "addon");
      expect(await addonSub()).toMatchObject({
        plan: "extra_seats",
        quantity: 2,
        status: "active",
      });
      expect((await ent.check(customer, "seats")).limit).toBe(5 + 10);
      if (driver.multiItem) {
        state = step({ items: [{ id: driver.ids.legacy, quantity: 1 }, seats(3)] });
        await send(state);
      } else {
        addon = step({ items: [seats(3)] }, addon);
        await send(addon!);
      }
      expect((await addonSub())!.quantity).toBe(3);
      expect((await ent.check(customer, "seats")).limit).toBe(5 + 15);
    });

    test("add-on removed: its entry is canceled, the plan stays", async () => {
      if (driver.multiItem) {
        state = step({ items: [{ id: driver.ids.legacy, quantity: 1 }] });
        expect((await send(state)).outcome).toBe("applied");
      } else {
        addon = step({ status: "canceled", canceledAt: iso() }, addon);
        expect((await send(addon!, { deleted: true })).outcome).toBe("applied");
      }
      const a = (await subs()).find((s) => s.kind === "addon");
      expect(a!.status).toBe("canceled");
      expect((await planSub())!.status).toBe("active");
      expect((await ent.check(customer, "seats")).limit).toBe(5);
    });

    test("cancel at period end: entitled until the period passes", async () => {
      state = step({ cancelAtPeriodEnd: true, periodEnd: iso(DAY) });
      expect((await send(state)).outcome).toBe("applied");
      expect((await planSub())!.cancelAtPeriodEnd).toBe(true);
      expect(await plans()).toEqual(["pro@1"]);
      clock.advance("2d");
      expect(await plans()).toEqual(["free@1"]);
      expect((await ent.check(customer, "export_pdf")).allowed).toBe(false);
    });

    test("subscription ends: canceled", async () => {
      state = step({ status: "canceled", canceledAt: iso() });
      expect((await send(state, { deleted: true })).outcome).toBe("applied");
      expect((await planSub())!.status).toBe("canceled");
    });

    test("resubscribe: a new subscription grants pro again", async () => {
      state = step({
        ref: ref(3),
        status: "active",
        items: [{ id: driver.ids.pro, quantity: 1 }],
        cancelAtPeriodEnd: false,
        canceledAt: undefined,
        periodStart: iso(),
        periodEnd: iso(30 * DAY),
      });
      expect((await send(state)).outcome).toBe("applied");
      expect(await plans()).toEqual(["pro@2"]);
      expect((await subs()).filter((s) => s.kind === "plan")).toHaveLength(2);
    });

    test("out-of-order delivery: an older update is stale and changes nothing", async () => {
      const older = { ...state, status: "past_due" as const, updatedAt: iso(-10 * 60_000) };
      expect((await send(older)).outcome).toBe("stale");
      expect((await planSub())!.status).toBe("active");
    });

    test("duplicate delivery: the same event is applied once", async () => {
      state = step({ items: [{ id: driver.ids.pro, quantity: 1 }] });
      expect((await send(state, { eventId: "evt_dup" })).outcome).toBe("applied");
      const revision = (await ent.getCustomer(customer))!.revision;
      expect((await send(state, { eventId: "evt_dup" })).outcome).toBe("duplicate");
      expect((await ent.getCustomer(customer))!.revision).toBe(revision);
    });

    test("unknown price: ignored, reported through onUnmapped", async () => {
      const unknown = step({ ref: ref(4), items: [{ id: "999999", quantity: 1 }] });
      expect((await send(unknown)).outcome).toBe("ignored");
      expect(unmapped.at(-1)).toMatchObject({ reason: "unknown_item", provider: name, customer });
      expect((await subs()).some((s) => s.providerRef === ref(4))).toBe(false);
    });

    test("bad signature → BillingVerificationError (400), nothing applied", async () => {
      const revision = (await ent.getCustomer(customer))!.revision;
      await expect(
        billing.handleWebhook(name, await driver.badSignature(state)),
      ).rejects.toBeInstanceOf(BillingVerificationError);
      expect((await ent.getCustomer(customer))!.revision).toBe(revision);
    });

    test("expired timestamp → BillingVerificationError", async () => {
      if (!driver.expired) {
        expect(driver.signsTimestamp).toBe(false); // nothing to expire; replays dedupe by body hash
        return;
      }
      await expect(billing.handleWebhook(name, await driver.expired(state))).rejects.toThrow(
        /tolerance/,
      );
    });
  });
}
