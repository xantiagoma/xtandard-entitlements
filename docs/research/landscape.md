# Landscape: entitlements, plans, usage metering and feature gating for SaaS billing (research gate)

> Sections 1–8 are the pre-kickoff research report. **Section 0** is the kickoff re-check made by
> the project lead on the same day, right before design; where they differ, section 0 wins.

Date of research: 2026-11-20. "Recent" means activity on or after 2026-05-20 (about 6 months).

Method: `gh search repos` on the topics `usage-based-billing`, `metering`, `entitlements`, `billing`,
`pricing`, `subscription-billing`, `feature-gating`, `paywall`, `monetization` and `usage-metering`, plus
keyword search `entitlements saas plans --created ">2025-11-20"`. `gh api` for stars, pushes, releases,
contributors and commits; the LICENSE text decoded and read for every candidate. The README and package tree were read for
PayKit, Subscrio, byo-oss/entitlements, OpenMeter, Polar and Closure. npm `view` and the downloads API for every
SDK and library. For repos that now 404, `curl` of github.com plus Wayback snapshots (fetched with curl;
the license and star count were grepped from the archived HTML). Web search for Stigg / Schematic
alternatives, Show HN launches and the OpenMeter acquisition.

Star, download and issue counts are as of 2026-11-20. "unknown" means I could not verify it.

What we are comparing against: an **embeddable, self-hosted, MIT TypeScript library**. You declare a
typed plan / feature / limit catalog in code, resolve a customer's (or org's) entitlements in-process,
meter usage with atomic counters and resets, take grants, overrides, trials and credits, and sync plan
state from *any* billing provider. It ships with pluggable storage, framework adapters, an embeddable React admin
UI and a customer-facing usage / plan portal, and it builds on @xtandard/flags evaluation.

---

## 0. Kickoff re-check (2026-11-20, before design)

Method: `gh api` (repo, commits on every branch, releases, open PRs, package manifests), `curl` status
codes for removed repos, `npm view` + the downloads API, `gh search repos --created ">2026-09-01"`
for "entitlements" / "billing typescript" / "metering", and the npm registry search for
"entitlements plans usage" and `keywords:entitlements`. READMEs read for anything new that looked
like an in-process engine.

**PayKit (getpaykit/paykit), the closest match: unchanged, still quiet.**

- MIT, 1,076★, 38 open issues, not archived. Last commit on `main` and on *any* branch is still
  **2026-09-27** (UI/docs polish PRs #217–#220); `dev` was last touched 2026-04-09. That is now
  **~8 weeks with no commits**. Last release v0.2.0 (2026-09-17); npm `paykitjs` 0.2.0, **407 dl/mo**.
- **Dashboard still unpublished:** `packages/dash/package.json` is `"private": true` (v0.0.6), and
  `npm view @paykitjs/dash` returns 404.
- **No new framework adapters:** `packages/paykit` exports are still `.`, `./handlers/next`,
  `./client` and `./database` only.
- **Still Stripe + Postgres:** runtime deps still include `stripe`, `pg`, `drizzle-orm` and
  `posthog-node` (telemetry). The open PRs that would widen it (#167 Dodo Payments provider,
  #204 multi-item subscriptions, #183/#185) have not moved since May–August.

**Autumn and Flowglad: still closed.** `github.com/useautumn/autumn` and
`github.com/flowglad/flowglad` both return **HTTP 404**. The `useautumn` org's public repos are SDKs,
templates and docs (`typescript` MIT, `autumn-py` MIT, …) but no server. `autumn-js` 1.6.35 is still
MIT with ~2.06M dl/mo (an SDK for the hosted / BYOC product). Flowglad's public repos are SDKs and
starters; `@flowglad/server` 0.18.0 last published 2026-03-03.

**New since the report (none is a permissive, maintained, embeddable equivalent):**

| Package | License | Activity / adoption | What it is | Why it does not close the gap |
|---|---|---|---|---|
| `@formata/limitr` (dev-formata-io/limitr) | Apache-2.0 | 10★, 1 contributor, created 2026-01, pushed 2026-11-20; 3.1k dl/mo | In-process limits / credits / billing **policy engine** (YAML policy, `allow(customer, feature, n)`), TS + Python, built on the Stof runtime | One maintainer; open-core (the dashboard, customer data and pricing changes are **Limitr Cloud**); no storage ports, billing-provider sync, framework adapters or embeddable UI; policy DSL rather than a typed TS catalog. Closest new idea; worth borrowing "credit cost vs. price" |
| `@12-apps/entitlements` | MIT (npm) | 58k dl/mo, repo `12-apps/shared-packages` has no LICENSE file, 0★, one maintainer | Layered plan/feature resolution, quotas, 402-vs-403 semantics, Hono + React | An internal monorepo package (depends on `@12-apps/ui`, peers on `@12-apps/wiring`); no metering store, billing sync or admin. Borrow: **402 (payment required) vs 403 (forbidden)** denial semantics |
| `@happyvertical/smrt-subscriptions` | MIT | 19k dl/mo | Subscriptions + entitlements for the SMRT framework (Svelte) | Framework-bound |
| `stiggio/stigg-agent-sdk-ts` | MIT SDK | 9★ | "Check entitlements before an AI call, meter after" | SDK for hosted Stigg |
| `gatefit` | MIT | 944 dl/mo | CI test pack asserting a Stripe-entitlement DB survives billing transitions | Testing aid, not an engine. Borrow its transition list for our webhook tests |
| `@molecule/api-entitlements`, `@agenticprimitives/entitlements`, `saasicat` | Apache / MIT / **PolyForm Shield** | ≤4k dl/mo | Framework-specific tier limits; VC-credential authorization; a source-available SaaS framework | Different problem or not OSI |

**Verdict at kickoff: still BUILD.** No permissive, maintained, embeddable, provider-agnostic
entitlements engine with storage ports, adapters and an embeddable admin + portal exists. PayKit
remains the reference to beat (and has gone quieter, not broader); Autumn and Flowglad remain closed;
Limitr is the only new in-process engine and it is open-core, single-maintainer and DSL-based.
Extra takeaways folded into the design: 402-vs-403 denial semantics (`@12-apps/entitlements`),
price-vs-cost per credit unit (Limitr), and a billing-transition test matrix (gatefit).

---

## 1. Billing platforms (services)

| Project | License (file read) | Activity | Shape | Entitlements? | Why not sufficient |
|---|---|---|---|---|---|
| getlago/lago | **AGPL-3.0** | 10,907★, v1.57.0 on 2026-11-05, pushed 2026-11-19 | Rails/Go service + Postgres + Redis (+ ClickHouse) | Billing-first; third-party reviews note it does not manage feature entitlements directly | License; service |
| flexprice/flexprice | **AGPL-3.0** (© Squirrelly Technologies) | 6,876★, v2.1.51 on 2026-11-19 | Go service (Kafka, ClickHouse, Temporal) | ✓ entitlements + credits | License; heavy service |
| meteroid-oss/meteroid | **AGPL-3.0** | 1,369★, v2.2.3 on 2026-11-13 | Rust service | ✓ | License; service |
| **openmeterio/openmeter** | **Apache-2.0** | 2,458★, v1.0.0-beta.238 on 2026-11-20 | Go service (Kafka + ClickHouse + Postgres); `@openmeter/sdk` 218k dl/mo | ✓ **entitlements API** (boolean / static / metered with grants) | Heavy service, not a library. **Kong acquired OpenMeter on 2025-09-03** and sells it as Konnect Metering & Billing. Kong says the OSS project continues upstream (still active), but its roadmap is now Kong's |
| killbill/killbill | Apache-2.0 | 5,860★, 0.24.22 on 2026-09-29 | Java platform + Kaui admin | Catalog / subscriptions; no runtime gating | JVM service |
| uselotus/lotus | MIT | 1,843★, **last release 0.10.2 on 2023-03-23**; recent commits are dependency bots (2026-08-12) | Django service | ✓ (it was) | Effectively dead |
| polarsource/polar | Apache-2.0 | 10,503★, pushed 2026-11-20 | Python **merchant-of-record** SaaS (`@polar-sh/sdk` 1.77M dl/mo, `@polar-sh/better-auth` 241k dl/mo) | Benefits / meters / credits on Polar's platform | The code is open, but the product is the hosted MoR; you don't embed it |
| Hexclave (formerly Stack Auth; `stack-auth/stack` 301 → `hexclave/hexclave`) | Per package: **server AGPL-3.0**, clients MIT | 6,895★, pushed 2026-11-20 | Auth platform with "Payments … usage metering with credits" | Partial | AGPL server; auth-platform-bound |

## 2. OSS billing layers whose public repos disappeared in 2026

- **Autumn (useautumn/autumn), YC.** An Apache-2.0 "open-source pricing & billing platform" over Stripe.
  A Wayback snapshot from **2026-06-10** shows **2,580★, Apache-2.0, dirs `apps/ packages/ server/ vite/`**.
  On **2026-11-20, `https://github.com/useautumn/autumn` returns HTTP 404**, and the org's public repos
  list no longer has it. The npm packages are still published with `repository: useautumn/autumn` and
  heavy usage: `autumn-js` 1.6.35 (MIT, **2.06M dl/mo**) and `atmn` (MIT, 1.65M dl/mo). Autumn's docs now
  stress running "in your own AWS account" (BYOC). The server is effectively no longer public OSS; I
  found no announcement explaining why.
- **Flowglad (flowglad/flowglad).** "Open source, webhook-free payments". A Wayback snapshot from
  2026-07-11 shows **1,717★ with a custom ("View license") LICENSE**. On **2026-11-20 the repo returns
  404**. `@flowglad/server` and `@flowglad/react` 0.18.0 have no license field and a few hundred dl/mo.
- Context: Cal.com also moved its core to a closed repo in April 2026
  (https://cal.com/blog/cal-diy-open-source-to-closed-source). **OSS billing and infrastructure startups
  are closing their source**, which is itself an argument for an MIT library with no company behind it.

## 3. Proprietary entitlement SaaS (the products we'd be the OSS answer to)

| Product | OSS parts | Notes |
|---|---|---|
| **Stigg** | MIT SDKs (`@stigg/node-server-sdk` 222k dl/mo, `stigg-agent-sdk-ts`), Apache CLI | Hosted entitlements + metering; BYOC sidecar for enterprises |
| **Schematic** | MIT SDKs (`@schematichq/schematic-typescript-node` 66k dl/mo, `@schematichq/schematic-react` 28k) | "Feature flags tied to billing plans" plus embeddable components (pricing table, customer portal) |
| Autumn Cloud | see §2 | |
| Metronome, Orb, Amberflo, Moesif, Octane | SDKs only | Usage billing SaaS |
| Stripe Entitlements | — | Stripe's own feature list per product. Third-party writeups note it doesn't enforce limits or meter in-app |

## 4. Embeddable TypeScript libraries (the shape we want)

| Package | License (file read) | Activity / adoption | Shape | What it lacks |
|---|---|---|---|---|
| **getpaykit/paykit** (`paykitjs`) | **MIT** | **1,076★**, created 2026-02-08, 13 contributors, 38 open issues; v0.2.0 on 2026-09-17; **last commit 2026-09-27** (13 commits in Aug, 87 in Sep, **none since**); npm **407 dl/mo** | **"Embedded Stripe billing framework for TypeScript apps. Runs inside your app, uses your database."** `plan()` / `feature()` catalog in code, subscriptions, entitlements, metered features with resets, webhooks handled, CLI `paykitjs init` | **The closest match.** But: **Stripe-only** (the migration `0001_stripe_only_schema.sql` dropped earlier Polar / Razorpay / Whop provider work: PRs #171, #176, #190); **Postgres-only** (drizzle + `pg` hard deps); **one framework handler** (`./handlers/next`); its dashboard package `@paykitjs/dash` is **`private: true`** (unpublished); `posthog-node` is a runtime dependency (telemetry); pre-1.0; 8 weeks without a commit |
| subscrio/subscrio-typescript (`subscrio`) | MIT | 2★, created 2026-08-23, v0.5.0 on 2026-09-23; 317 dl/mo | Entitlement engine: toggles / numeric / text features, customer overrides, plans, billing cycles, trials, optional Stripe events, hooks, config sync | Postgres-only runtime; no framework adapters or UI; no metering counters beyond limits; tiny |
| byo-oss/entitlements (`@byo-oss/entitlements`) | MIT | 1★, v0.4.0 on 2026-11-13; 1,060 dl/mo; 1 maintainer | **better-auth plugin**: typed catalog (`/catalog` imports nothing), atomic `consumeUsage`, staff overrides with audit, React `EntitlementGate` / `UsageMeter`, billing source via `@better-auth/stripe`, contract test suite | **Bound to better-auth organizations**; no admin UI or portal; single maintainer. Its design is well thought out (see takeaways) |
| `@better-auth/stripe` | MIT | 2.19M dl/mo, 2026-11-20 | Better Auth subscription plugin with per-plan `limits` | Subscriptions only; no metering or enforcement engine |
| disjointinc/closure | MIT | 16★, created 2026-08-18, pushed 2026-10-15 | Pricing / metering **service** (Redis hot path + Postgres + Hatchet) | Service; tiny |
| velobase/velobase-harness | MIT | 624★, v0.2.0 on 2026-09-11 | AI-SaaS starter ("turn your prototype into paid SaaS") | A starter app, not a library |
| prici-io/prici | MIT | 49★, **last push 2024-07-04** | Plans and pricing service + SDK | Dead |
| axelgar/bismite | MIT | 0★, 27 dl/mo, last push 2026-07-03 | "SDK-first billing & entitlements runtime on Stripe" | Toy-sized; dormant |
| geminimir/meterguard | MIT | 25★, last push 2026-06-30 | Stripe usage metering | Metering only |
| horn111/resvary, Zonastery/bursar | NOASSERTION / **AGPL** | 2026, ≤4★ | Prepaid credits / reserve-settle for AI | Tiny; one is AGPL |
| dodopayments/billingsdk | **GPL-3.0** | 513★ | React billing UI components | Copyleft; UI only |
| Other languages | MIT | — | `rameerez/usage_credits` (Rails, 168★), `moneo/laravel-usage-limiter`, `vimatech-io/laravel-quotas`, `NKSTUD/django-entitlements`, `subscrio-dotnet`, `terpomo-io/pmitz` (Java), Laravel Cashier | Not TS |

## 5. Feature-flag platforms (where entitlements usually get hacked in)

Unleash, Flagsmith, GrowthBook, Flipt and **@xtandard/flags** can gate by a `plan` attribute in the
evaluation context. None of them models limits, usage counters, resets, grants, trials or billing-provider sync.
Schematic's whole pitch is "flags tied to plans", which is exactly the layer missing on top of
@xtandard/flags.

---

## 6. Summary table

| Name | License (verified) | Last activity | Shape | Embeddable TS lib? | Why not sufficient |
|---|---|---|---|---|---|
| Lago / Flexprice / Meteroid | **AGPL-3.0** | 2026-11 | Billing services | ✗ | License |
| OpenMeter | Apache-2.0 | 2026-11-20 | Go service (Kafka, ClickHouse) | ✗ | Heavy service; Kong-owned since 2025-09 |
| Kill Bill | Apache-2.0 | 2026-11-19 | Java platform | ✗ | JVM service |
| Lotus | MIT | release 2023-03 | Django service | ✗ | Dead |
| Polar | Apache-2.0 | 2026-11-20 | Hosted MoR | ✗ | It's a merchant of record, not a library |
| Autumn | was Apache-2.0 | **repo 404 on 2026-11-20** (2.6k★ in June) | Service over Stripe + SDKs | ✗ | Server no longer public |
| Flowglad | custom | **repo 404** | Payments service | ✗ | Gone / non-OSI |
| Stigg / Schematic | proprietary (MIT SDKs) | 2026-11 | SaaS | ✗ | Hosted |
| **PayKit** | **MIT** | **2026-09-27** | **Embedded TS framework** | ✓ | Stripe-only, Postgres-only, Next-only handler, dashboard unpublished, telemetry dep, quiet 8 weeks |
| Subscrio | MIT | 2026-09-23 | TS library | ✓ | Postgres-only, no adapters/UI, 2★ |
| @byo-oss/entitlements | MIT | 2026-11-13 | better-auth plugin | ✓ (better-auth only) | Framework-bound; no admin UI; one maintainer |
| @better-auth/stripe | MIT | 2026-11-20 | better-auth plugin | partial | Subscriptions + static limits only |
| Closure | MIT | 2026-10-15 | Service | ✗ | Service; tiny |

## 7. Takeaways to borrow

1. **Catalog as code, importable anywhere** (byo-oss `/catalog` imports nothing; PayKit `plan()` /
   `feature()`). The same file drives the server, client gating and the public pricing page.
2. **Feature kinds:** boolean, metered (usage with reset: day / month / billing-cycle), capacity (seats,
   projects: a current count rather than a consumption counter), and value (string / number config). OpenMeter adds *grants* (one-time or
   recurring balances with priority and expiry). Autumn and Polar add *credits* (prepaid balance across
   features).
3. **Atomic consume, never read-then-write** (`consumeUsage` as one guarded increment); a refusal never
   counts. Support **reserve → settle** for AI calls where the cost is known after the fact (Closure,
   resvary, bursar).
4. **Checks return a reason, not a 500:** `{ allowed, reason, balance, unlockedBy: [plans] }` so UIs can
   show an upsell (byo-oss, Schematic).
5. **Overrides with audit:** comp a feature, raise a limit or switch a plan, with reason and expiry
   (byo-oss, Subscrio, Stigg).
6. **Billing provider is a port, not the core.** PayKit's narrowing to Stripe-only shows that putting the
   provider in the schema is the trap; keep plan *state* provider-agnostic and sync from Stripe / Polar /
   Paddle / Lemon Squeezy / manual.
7. **Hot path in memory, durable store behind it** (Closure: Redis + Postgres batches; Stigg: an edge
   cache). This is exactly @xtandard/flags' memory-first, last-known-good design.

## 8. Verdict: **BUILD** (`@xtandard/entitlements`), narrowly scoped and checked against PayKit

**The gap.** The permissive, maintained projects are services (OpenMeter, Kill Bill), a hosted merchant
of record (Polar), or AGPL (Lago, Flexprice, Meteroid, Hexclave's server). The best-known open layer over
Stripe, Autumn, **took its server repo private / offline** in 2026, and Flowglad did the same. The
embeddable TS libraries that exist are each boxed in. **PayKit** (MIT, 1.1k★) has the right idea, but it
is Stripe-only by schema, Postgres + Next only, its dashboard is unpublished, it ships telemetry, and it
has had no commits for 8 weeks. Subscrio is Postgres-only with no UI. byo-oss is welded to better-auth.
Nobody offers a **billing-provider-agnostic, storage-pluggable, framework-agnostic entitlements and
metering engine with an embeddable admin UI and customer portal**, which is exactly what Stigg and
Schematic charge for. It also fits the ecosystem: entitlements are "flags whose targeting is the plan,
plus counters", and @xtandard/flags already has the memory-first evaluator, storage ports, adapters and
admin UI shell.

Recommend instead, if the user doesn't want to build it: **PayKit**, for a Stripe + Postgres + Next.js app
that accepts its telemetry dependency and pre-1.0 churn; **@byo-oss/entitlements**, if the app is already on
better-auth organizations. Re-check PayKit before kickoff: if it publishes its dashboard and adds
non-Next adapters, the gap narrows to "provider-agnostic plus flags integration".

**Sketch of the xtandard-shaped product:**
- **Catalog (`/catalog`, zero deps):** `defineCatalog({ features, plans, addons })` with typed feature
  kinds (boolean / metered + reset / capacity / value / credits), plan groups (base vs. add-on), trials
  and versioned plans (grandfathering). Export a JSON pricing table for marketing pages.
- **Engine:** `createEntitlements({ catalog, storage, billing, flags? })`.
  `check(customer, feature)` → `{ allowed, reason, remaining, resetsAt, unlockedBy }`; `consume` /
  `reserve` + `settle`; `grant` (one-off or recurring balances with expiry and priority); `override`
  (reason, expiry, actor). The evaluation hot path is a memory-first snapshot per customer with
  last-known-good, as in flags, plus write-behind counters.
- **Flags bridge:** expose entitlements as an OpenFeature provider / evaluation-context enricher so
  `@xtandard/flags` rules can target `entitlement.pro_export == true`. Rollouts and entitlements share one
  gate.
- **Storage ports:** Drizzle Postgres / SQLite / MySQL plus memory, with a contract suite. A counter port
  with Redis and DB implementations, so atomic increments can live in Redis with a DB ledger behind them.
- **Billing ports:** Stripe, Polar, Paddle, Lemon Squeezy, `@better-auth/stripe` and `manual`. Each maps
  provider subscriptions to `{ customer, plan, status, period }`. The webhook intake reuses
  **@xtandard/webhooks** verification. Optional usage export (push metered usage to Stripe meters).
- **Adapters:** Elysia / Hono / Express / Bun / Next route handlers (check, consume, customer portal API);
  React `useEntitlement`, `<Gate>`, `<UsageMeter>`, `<PricingTable>`, `<UpgradePrompt>`.
- **UI:** an embeddable **admin** (catalog view, customer lookup, overrides, grants, usage graphs) and a
  **customer portal** (current plan, usage vs. limits, invoices via provider link-outs), with scoped
  tokens.
- **Ecosystem:** overrides and plan changes go to **@xtandard/audit**; threshold events ("80% of quota")
  go out via **@xtandard/webhooks**.
- **Non-goals:** invoicing, tax, dunning and payments. Those stay with the provider (Stripe / Polar).
  That boundary is what keeps it a library and not another Lago.

Sources: https://github.com/getpaykit/paykit, https://github.com/subscrio/subscrio-typescript,
https://github.com/byo-oss/entitlements, https://github.com/openmeterio/openmeter,
https://konghq.com/blog/news/kong-acquires-openmeter, https://www.thestack.technology/api-gateway-firm-kong-snaps-up-openmeter/,
https://github.com/polarsource/polar, https://github.com/getlago/lago, https://github.com/flexprice/flexprice,
https://github.com/meteroid-oss/meteroid, https://github.com/hexclave/hexclave,
http://web.archive.org/web/20260610131505/https://github.com/useautumn/autumn,
http://web.archive.org/web/20260711184002/https://github.com/flowglad/flowglad, https://docs.useautumn.com/,
https://www.startuphub.ai/news/claudes-corner-autumn-yc-w2026, https://cal.com/blog/cal-diy-open-source-to-closed-source,
https://schematichq.com/blog/entitlements-for-stripe, https://www.stigg.io/blog-posts/entitlement-management-software
