# Mission: `@xtandard/entitlements`

You are the **lead** for a new project in the user's xtandard ecosystem: **a billing-provider-agnostic,
storage-pluggable, framework-agnostic entitlements, plans and usage-metering engine as an embeddable
library** (the Stigg / Schematic / Autumn niche, in the xtandard shape), built to pair with
`@xtandard/flags`. You own it end to end: research check, design, implementation, tests, docs, docs site,
CI/CD and release prep. **Do not stop until the Definition of Done is met.**

Your coordinator is the hc terminal **`t1r`** (report with `hc send t1r "…"`; its messages arrive tagged
`<hc from="t1r …">`). Keep this file unedited; your plan goes in `PLAN.md`, progress in `WORKLOG.md`.

**Read first, fully:** `/Users/santi/Projects/xtandard-missions/ecosystem-lead-rules.md` (how to work:
references, team, rules, reporting, Definition of Done; `<name>` = `entitlements`, package
`@xtandard/entitlements`, repo `xantiagoma/xtandard-entitlements`, docs at
`https://me.xantiagoma.com/xtandard-entitlements/`).

**What to build:** the research report `/Users/santi/Projects/xtandard-missions/research/entitlements.md`
(section 8 "Verdict" has the gap and the product sketch: zero-dep typed catalog (features, plans,
add-ons, trials, versioned plans), engine with check / consume / reserve+settle / grant / override on a
memory-first per-customer snapshot with write-behind counters, a bridge into @xtandard/flags
(OpenFeature provider / context enricher), storage + counter ports with contract tests, billing ports
(Stripe, Polar, Paddle, Lemon Squeezy, better-auth stripe, manual) with webhook intake, framework
adapters, React hooks/components (useEntitlement, Gate, UsageMeter, PricingTable, UpgradePrompt),
embeddable admin + customer portal, bridges to @xtandard/audit and @xtandard/webhooks; non-goals:
invoicing, tax, dunning, payments). Treat that sketch as the starting scope; refine it in PLAN.md + ADRs.
Read `/Users/santi/Projects/xtandard-flags` especially closely: this project should feel like its sibling.

**Research check first:** re-check PayKit (getpaykit/paykit: did it publish its dashboard, add non-Next
adapters, resume commits?), Autumn and Flowglad (still closed?), and anything new; commit it as
`docs/research/landscape.md` (start from the research report) and send t1r a short verdict. If a
permissive, maintained, embeddable equivalent now exists, stop and report; otherwise continue.
