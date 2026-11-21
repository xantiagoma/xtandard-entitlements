/**
 * The demo dataset behind `bun run demo`, the Playwright e2e server and the
 * README screenshots: a realistic SaaS catalog (free / pro / business, a hidden
 * enterprise plan, a grandfathered pro v1, add-ons, Stripe + Polar mappings)
 * and ~30 customers with trials, past-due payments, cancellations, grants,
 * overrides and 30 days of usage history.
 *
 * The engine runs on a movable clock so the history is *real*: usage is
 * consumed day by day from 30 days ago (daily series, period counters and
 * activity timestamps all line up), then the clock is released to wall time.
 * Deterministic (seeded PRNG), so screenshots are reproducible.
 *
 * @module
 */

import { defineCatalog, feature } from "../src/catalog.ts";
import { createMemoryCounterStore } from "../src/counters/memory.ts";
import { createEntitlements, type Entitlements } from "../src/engine.ts";
import type { Actor } from "../src/schema.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

const DAY = 86_400_000;

/** The demo catalog. */
export const demoCatalog = defineCatalog({
  features: {
    seats: feature.capacity({ name: "Seats", unit: "seat", units: "seats" }),
    projects: feature.capacity({ name: "Projects", unit: "project", units: "projects" }),
    api_calls: feature.metered({
      name: "API calls",
      unit: "call",
      units: "calls",
      reset: "month",
      thresholds: [0.8, 1],
    }),
    ai_credits: feature.credits({
      name: "AI credits",
      unit: "credit",
      units: "credits",
      reset: "month",
    }),
    export_pdf: feature.boolean({ name: "PDF export" }),
    audit_log: feature.boolean({ name: "Audit log" }),
    sso: feature.boolean({ name: "SAML SSO" }),
    priority_support: feature.boolean({ name: "Priority support" }),
    max_upload_mb: feature.value({ name: "Max upload (MB)", default: 25 }),
    data_retention_days: feature.value({ name: "Data retention (days)", default: 7 }),
  },
  plans: {
    free: {
      name: "Free",
      description: "For side projects and trying things out.",
      default: true,
      features: { seats: 3, projects: 2, api_calls: 1_000 },
    },
    pro: {
      name: "Pro",
      description: "For growing teams shipping to production.",
      version: 2,
      highlight: true,
      trial: { days: 14 },
      price: { amount: 2900, currency: "usd", interval: "month" },
      providers: { stripe: ["price_pro_monthly_v2"], polar: ["prod_pro"] },
      features: {
        seats: 10,
        projects: 20,
        api_calls: 100_000,
        ai_credits: 5_000,
        export_pdf: true,
        audit_log: true,
        max_upload_mb: 250,
        data_retention_days: 90,
      },
      previous: {
        1: {
          price: { amount: 1900, currency: "usd", interval: "month" },
          providers: { stripe: ["price_pro_monthly_v1"] },
          features: {
            seats: 5,
            projects: 10,
            api_calls: 50_000,
            export_pdf: true,
            max_upload_mb: 100,
            data_retention_days: 30,
          },
        },
      },
    },
    business: {
      name: "Business",
      description: "Security, compliance and scale for larger organizations.",
      trial: { days: 14 },
      price: { amount: 9900, currency: "usd", interval: "month" },
      providers: { stripe: ["price_business_monthly", "price_business_yearly"] },
      features: {
        seats: 50,
        projects: "unlimited",
        api_calls: { limit: 1_000_000, overage: "allow" },
        ai_credits: 25_000,
        export_pdf: true,
        audit_log: true,
        sso: true,
        priority_support: true,
        max_upload_mb: 2_048,
        data_retention_days: 365,
      },
    },
    enterprise: {
      name: "Enterprise",
      description: "Custom contracts.",
      hidden: true,
      price: { amount: 0, currency: "usd", label: "Custom" },
      providers: { stripe: ["price_enterprise_custom"] },
      features: {
        seats: "unlimited",
        projects: "unlimited",
        api_calls: "unlimited",
        ai_credits: 100_000,
        export_pdf: true,
        audit_log: true,
        sso: true,
        priority_support: true,
        max_upload_mb: 10_240,
        data_retention_days: 730,
      },
    },
  },
  addons: {
    extra_seats: {
      name: "+5 seats",
      description: "Five more seats on any paid plan.",
      quantity: { max: 20 },
      requires: ["pro", "business"],
      price: { amount: 1000, currency: "usd", interval: "month" },
      providers: { stripe: ["price_extra_seats"] },
      features: { seats: { add: 5 } },
    },
    ai_boost: {
      name: "AI boost",
      description: "10,000 extra AI credits every month.",
      requires: ["pro", "business"],
      price: { amount: 1900, currency: "usd", interval: "month" },
      providers: { stripe: ["price_ai_boost"] },
      features: { ai_credits: { add: 10_000 } },
    },
  },
});

/** A clock that can be pinned in the past, then released to wall time. */
export interface DemoClock {
  now(): number;
  /** Pin the clock (unix ms), or `null` to follow wall time. */
  set(at: number | null): void;
}

/** Create a {@link DemoClock} (following wall time). */
export function createDemoClock(): DemoClock {
  let pinned: number | null = null;
  return {
    now: () => pinned ?? Date.now(),
    set: (at) => {
      pinned = at;
    },
  };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type PlanKey = "free" | "pro" | "business" | "enterprise";

/** One demo customer. `load` = target share of the monthly API-call limit used by today. */
interface DemoCustomer {
  id: string;
  name: string;
  plan: PlanKey;
  version?: number;
  status?: "active" | "trialing" | "past_due" | "canceled";
  /** Trial end, days from now (trialing only). */
  trialDays?: number;
  cancelAtPeriodEnd?: boolean;
  provider?: string;
  load: number;
  aiLoad?: number;
  seats: number;
  projects: number;
  /** Customer age in days. */
  age: number;
  addons?: Array<{ key: "extra_seats" | "ai_boost"; quantity?: number }>;
}

/** The customers: fictional companies (Microsoft's sample-data names and friends). */
export const DEMO_CUSTOMERS: DemoCustomer[] = [
  {
    id: "northwind",
    name: "Northwind Traders",
    plan: "business",
    load: 0.62,
    aiLoad: 0.71,
    seats: 38,
    projects: 41,
    age: 410,
    addons: [{ key: "ai_boost" }],
  },
  {
    id: "contoso",
    name: "Contoso Ltd",
    plan: "enterprise",
    load: 0.3,
    aiLoad: 0.44,
    seats: 212,
    projects: 96,
    age: 620,
    provider: "stripe",
  },
  {
    id: "fabrikam",
    name: "Fabrikam Inc",
    plan: "pro",
    load: 1.02,
    aiLoad: 0.88,
    seats: 10,
    projects: 17,
    age: 233,
  },
  {
    id: "tailspin",
    name: "Tailspin Toys",
    plan: "pro",
    load: 0.41,
    aiLoad: 0.2,
    seats: 6,
    projects: 9,
    age: 150,
  },
  {
    id: "wingtip",
    name: "Wingtip Toys",
    plan: "pro",
    status: "past_due",
    load: 0.57,
    aiLoad: 0.35,
    seats: 8,
    projects: 12,
    age: 301,
  },
  {
    id: "adventure-works",
    name: "Adventure Works",
    plan: "business",
    load: 0.81,
    aiLoad: 0.52,
    seats: 44,
    projects: 63,
    age: 512,
    addons: [{ key: "extra_seats", quantity: 2 }],
  },
  {
    id: "litware",
    name: "Litware Inc",
    plan: "pro",
    version: 1,
    load: 0.66,
    seats: 5,
    projects: 8,
    age: 702,
  },
  {
    id: "proseware",
    name: "Proseware",
    plan: "pro",
    version: 1,
    load: 0.35,
    seats: 4,
    projects: 6,
    age: 655,
  },
  {
    id: "woodgrove",
    name: "Woodgrove Bank",
    plan: "business",
    load: 0.47,
    aiLoad: 0.62,
    seats: 31,
    projects: 22,
    age: 389,
  },
  {
    id: "alpine-ski",
    name: "Alpine Ski House",
    plan: "pro",
    status: "trialing",
    trialDays: 2,
    load: 0.18,
    aiLoad: 0.12,
    seats: 4,
    projects: 3,
    age: 12,
  },
  {
    id: "blue-yonder",
    name: "Blue Yonder Airlines",
    plan: "business",
    status: "trialing",
    trialDays: 5,
    load: 0.09,
    aiLoad: 0.15,
    seats: 19,
    projects: 7,
    age: 9,
  },
  {
    id: "coho-winery",
    name: "Coho Winery",
    plan: "free",
    load: 0.58,
    seats: 2,
    projects: 2,
    age: 88,
  },
  {
    id: "fourth-coffee",
    name: "Fourth Coffee",
    plan: "pro",
    load: 0.77,
    aiLoad: 0.93,
    seats: 9,
    projects: 14,
    age: 199,
    addons: [{ key: "extra_seats" }],
  },
  {
    id: "graphic-design",
    name: "Graphic Design Institute",
    plan: "free",
    load: 0.98,
    seats: 3,
    projects: 2,
    age: 45,
  },
  {
    id: "humongous",
    name: "Humongous Insurance",
    plan: "business",
    status: "past_due",
    load: 0.39,
    aiLoad: 0.27,
    seats: 27,
    projects: 30,
    age: 276,
  },
  {
    id: "lucerne",
    name: "Lucerne Publishing",
    plan: "pro",
    load: 0.22,
    aiLoad: 0.41,
    seats: 7,
    projects: 5,
    age: 121,
  },
  {
    id: "margies-travel",
    name: "Margie's Travel",
    plan: "free",
    load: 0.31,
    seats: 1,
    projects: 1,
    age: 33,
  },
  {
    id: "relecloud",
    name: "Relecloud",
    plan: "pro",
    cancelAtPeriodEnd: true,
    load: 0.14,
    aiLoad: 0.05,
    seats: 3,
    projects: 4,
    age: 184,
  },
  {
    id: "southridge",
    name: "Southridge Video",
    plan: "free",
    load: 0.12,
    seats: 2,
    projects: 1,
    age: 21,
  },
  {
    id: "trey-research",
    name: "Trey Research",
    plan: "pro",
    status: "trialing",
    trialDays: 12,
    load: 0.05,
    aiLoad: 0.08,
    seats: 5,
    projects: 2,
    age: 2,
  },
  {
    id: "vanarsdel",
    name: "VanArsdel Ltd",
    plan: "business",
    load: 0.71,
    aiLoad: 0.84,
    seats: 48,
    projects: 74,
    age: 455,
  },
  {
    id: "wide-world",
    name: "Wide World Importers",
    plan: "pro",
    load: 0.52,
    aiLoad: 0.66,
    seats: 10,
    projects: 19,
    age: 266,
  },
  {
    id: "datum",
    name: "A. Datum Corporation",
    plan: "free",
    load: 0.74,
    seats: 3,
    projects: 2,
    age: 61,
  },
  {
    id: "bellows",
    name: "Bellows College",
    plan: "free",
    load: 0.2,
    seats: 2,
    projects: 1,
    age: 140,
  },
  {
    id: "best-for-you",
    name: "Best For You Organics",
    plan: "pro",
    status: "canceled",
    load: 0.02,
    seats: 1,
    projects: 1,
    age: 222,
  },
  {
    id: "consolidated",
    name: "Consolidated Messenger",
    plan: "pro",
    load: 0.84,
    aiLoad: 0.33,
    seats: 8,
    projects: 11,
    age: 342,
  },
  {
    id: "first-up",
    name: "First Up Consultants",
    plan: "free",
    load: 0.45,
    seats: 3,
    projects: 2,
    age: 74,
  },
  {
    id: "munsons",
    name: "Munson's Pickles and Preserves",
    plan: "free",
    load: 0.06,
    seats: 1,
    projects: 1,
    age: 15,
  },
  {
    id: "nod-publishers",
    name: "Nod Publishers",
    plan: "pro",
    load: 0.29,
    aiLoad: 0.57,
    seats: 6,
    projects: 7,
    age: 97,
  },
  {
    id: "fincher",
    name: "Fincher Architects",
    plan: "free",
    load: 0.37,
    seats: 2,
    projects: 2,
    age: 52,
  },
];

const OPS: Actor = {
  id: "u_sam",
  name: "Sam Rivera",
  email: "sam@yourcompany.example",
  type: "user",
};
const SUPPORT: Actor = {
  id: "u_ana",
  name: "Ana Okafor",
  email: "ana@yourcompany.example",
  type: "user",
};
const STRIPE: Actor = { id: "stripe", type: "billing:stripe" };

const slugEmail = (c: DemoCustomer) => `billing@${c.id.replace(/[^a-z0-9]/g, "")}.example`;

/** Monthly API-call allowance for a plan (for usage targets). */
function apiLimit(plan: PlanKey, version?: number): number {
  if (plan === "free") return 1_000;
  if (plan === "pro") return version === 1 ? 50_000 : 100_000;
  if (plan === "business") return 1_000_000;
  return 2_000_000;
}

function aiLimit(c: DemoCustomer): number {
  const base =
    c.plan === "pro"
      ? c.version === 1
        ? 0
        : 5_000
      : c.plan === "business"
        ? 25_000
        : c.plan === "enterprise"
          ? 100_000
          : 0;
  return base + (c.addons?.some((a) => a.key === "ai_boost") ? 10_000 : 0);
}

/** A scheduled seed step: run at `t` (unix ms) on the demo clock. */
interface Step {
  t: number;
  run: () => Promise<unknown>;
}

/**
 * Seed `ent` (whose `now` is `clock.now`) with the demo customers and 30 days
 * of history, ending at `end` (default: wall time). Every step runs at its own
 * time, in chronological order, so counters, daily series, subscription
 * periods and the activity log all agree. Leaves the clock released.
 */
export async function seedDemo(
  ent: Entitlements,
  clock: DemoClock,
  options: { end?: number; customers?: DemoCustomer[] } = {},
): Promise<{ customers: number }> {
  const end = options.end ?? Date.now();
  const customers = options.customers ?? DEMO_CUSTOMERS;
  const random = rng(42);
  const endDate = new Date(end);
  const today = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  const monthStart = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1);
  const daysThisMonth = Math.max(1, Math.round((today - monthStart) / DAY) + 1);
  const historyStart = today - 29 * DAY;
  const HOUR = 3_600_000;
  /** `daysAgo` days before `end`, at a fixed hour offset — never in the future. */
  const ago = (daysAgo: number, hours = 0) =>
    Math.min(end - 60_000, end - daysAgo * DAY + hours * HOUR);
  const steps: Step[] = [];
  const at = (t: number, run: () => Promise<unknown>) => steps.push({ t, run });

  for (const c of customers) {
    const signup = ago(c.age);
    const provider = c.provider ?? (c.id.length % 3 === 0 ? "polar" : "stripe");
    // 1. Signup: profile, then the subscription (+ add-ons).
    at(signup, () =>
      ent.updateCustomer(c.id, { name: c.name, email: slugEmail(c) }, { actor: OPS }),
    );
    if (c.plan !== "free") {
      // Monthly billing periods anchored on the signup day of month.
      const anchorDay = new Date(signup).getUTCDate();
      let periodStart = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), anchorDay);
      if (periodStart > end) {
        periodStart = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - 1, anchorDay);
      }
      const ps = new Date(periodStart);
      const periodEnd = Date.UTC(ps.getUTCFullYear(), ps.getUTCMonth() + 1, ps.getUTCDate());
      const period = {
        periodStart: new Date(periodStart).toISOString(),
        periodEnd: new Date(periodEnd).toISOString(),
      };
      if (c.status === "trialing") {
        at(signup + 5 * 60_000, () =>
          ent.upsertSubscription(
            c.id,
            {
              plan: c.plan,
              status: "trialing",
              trialEndsAt: new Date(end + (c.trialDays ?? 7) * DAY - 3 * HOUR).toISOString(),
              periodStart: new Date(signup).toISOString(),
              provider: "manual",
            },
            { actor: OPS },
          ),
        );
      } else {
        const ref = `sub_${c.id.replace(/[^a-z0-9]/g, "").slice(0, 10)}${Math.floor(random() * 1e6)}`;
        // The billing account behind the subscription (portal "Manage billing").
        at(signup + 4 * 60_000, () =>
          ent.link(
            c.id,
            provider,
            `${provider === "polar" ? "pc" : "cus"}_${c.id.replace(/[^a-z0-9]/g, "")}`,
          ),
        );
        at(signup + 5 * 60_000, () =>
          ent.upsertSubscription(
            c.id,
            {
              plan: c.plan,
              ...(c.version !== undefined ? { version: c.version } : {}),
              status: "active",
              ...period,
              provider,
              providerRef: ref,
            },
            { actor: STRIPE },
          ),
        );
        for (const a of c.addons ?? []) {
          at(signup + 10 * 60_000 + Math.floor(random() * 40) * DAY, () =>
            ent.upsertSubscription(
              c.id,
              {
                plan: a.key,
                kind: "addon",
                status: "active",
                quantity: a.quantity ?? 1,
                ...period,
                provider,
              },
              { actor: STRIPE },
            ),
          );
        }
      }
    }
    // Capacity in use (seats, projects) — a few weeks back.
    const capT = Math.max(signup + HOUR, ago(20 + Math.floor(random() * 6), 3));
    at(capT, () => ent.setUsage(c.id, "seats", c.seats));
    at(capT + 60_000, () => ent.setUsage(c.id, "projects", c.projects));

    // 2. 30 days of usage, one entry a day (weekday rhythm + gentle growth).
    if (c.status === "canceled") continue;
    for (let day = 0; day < 30; day++) {
      const dayStart = historyStart + day * DAY;
      // Today is partial: spread what has elapsed so far.
      const elapsed = Math.min(1, (end - dayStart) / DAY);
      const t = dayStart + Math.floor((elapsed < 1 ? elapsed * 0.9 : 9 / 24 + random() / 3) * DAY);
      if (t <= signup || t >= end) continue;
      const weekday = new Date(t).getUTCDay();
      const rhythm = weekday === 0 || weekday === 6 ? 0.45 : 1.12;
      const growth = 0.8 + (day / 29) * 0.4;
      const monthly = apiLimit(c.plan, c.version) * c.load;
      const daily = Math.round(
        (monthly / daysThisMonth) * rhythm * growth * elapsed * (0.7 + random() * 0.6),
      );
      const ai = aiLimit(c) * (c.aiLoad ?? 0);
      const aiDaily = Math.round(
        (ai / daysThisMonth) * rhythm * growth * elapsed * (0.6 + random() * 0.8),
      );
      at(t, async () => {
        if (daily > 0) await ent.consume(c.id, "api_calls", daily);
        if (aiDaily > 0) await ent.consume(c.id, "ai_credits", aiDaily);
      });
    }
  }

  // 3. Operator work: grants, overrides — and billing events.
  const iso = (t: number) => new Date(t).toISOString();
  at(ago(13, 2), () =>
    ent.grant(
      "fabrikam",
      {
        feature: "api_calls",
        amount: 5_000,
        expiresAt: iso(end + 40 * DAY),
        reason: "Launch-week headroom",
      },
      { actor: SUPPORT },
    ),
  );
  at(ago(11, 4), () =>
    ent.grant(
      "fourth-coffee",
      { feature: "ai_credits", amount: 500, reason: "Goodwill credit for the Nov 3 outage" },
      { actor: SUPPORT },
    ),
  );
  at(ago(9, 1), () =>
    ent.grant(
      "northwind",
      {
        feature: "ai_credits",
        amount: 5_000,
        recurring: true,
        reason: "Annual contract: +5k credits / month",
      },
      { actor: OPS },
    ),
  );
  at(ago(6, 5), () =>
    ent.grant(
      "graphic-design",
      {
        feature: "api_calls",
        amount: 100,
        expiresAt: iso(end + 10 * DAY),
        priority: 1,
        reason: "Education program",
      },
      { actor: SUPPORT },
    ),
  );
  at(ago(12, 3), () =>
    ent.override(
      "tailspin",
      {
        feature: "sso",
        enabled: true,
        expiresAt: iso(end + 30 * DAY),
        reason: "SSO pilot before the Business upgrade — approved by sales",
      },
      { actor: OPS },
    ),
  );
  at(ago(8, 6), () =>
    ent.override(
      "litware",
      { feature: "seats", limit: 8, reason: "Grandfathered deal: 8 seats on Pro v1" },
      { actor: OPS },
    ),
  );
  at(ago(4, 2), () =>
    ent.override(
      "datum",
      { feature: "export_pdf", enabled: true, reason: "Partner account" },
      { actor: SUPPORT },
    ),
  );
  at(ago(1, 3), () =>
    ent.override(
      "munsons",
      { feature: "api_calls", enabled: false, reason: "Abuse investigation #4471" },
      { actor: SUPPORT },
    ),
  );

  const planSub = async (id: string) =>
    (await ent.getCustomer(id))?.subscriptions.find(
      (s) => s.kind === "plan" && s.status !== "canceled",
    );
  for (const c of customers) {
    if (c.status === "past_due") {
      at(ago(2, 1), async () => {
        const sub = await planSub(c.id);
        if (sub)
          await ent.upsertSubscription(
            c.id,
            { id: sub.id, plan: sub.plan, provider: sub.provider, status: "past_due" },
            { actor: STRIPE },
          );
      });
    } else if (c.status === "canceled") {
      at(ago(16, 2), async () => {
        const sub = await planSub(c.id);
        if (sub) await ent.cancelSubscription(c.id, sub.id, { actor: STRIPE });
      });
    } else if (c.cancelAtPeriodEnd) {
      at(ago(0, -5), async () => {
        const sub = await planSub(c.id);
        if (sub)
          await ent.cancelSubscription(c.id, sub.id, {
            atPeriodEnd: true,
            actor: { id: `portal:${c.id}`, type: "portal" },
          });
      });
    }
  }

  steps.sort((a, b) => a.t - b.t);
  for (const step of steps) {
    clock.set(step.t);
    await step.run();
  }
  clock.set(null);
  ent.invalidate();
  return { customers: customers.length };
}

/** An in-memory engine on a {@link DemoClock}, seeded with the demo data. */
export async function createDemoEngine(): Promise<{
  ent: Entitlements<typeof demoCatalog>;
  clock: DemoClock;
}> {
  const clock = createDemoClock();
  const ent = createEntitlements({
    catalog: demoCatalog,
    storage: createMemoryStorage(),
    counters: createMemoryCounterStore({ now: clock.now }),
    now: clock.now,
    cache: { ttl: "2s" },
  });
  await seedDemo(ent as unknown as Entitlements, clock);
  return { ent, clock };
}
