# AI credits × @xtandard/entitlements

Meter LLM tokens against a prepaid **credit pool** with **reserve / settle**, and alert on usage
thresholds — a script, no server ([`src/demo.ts`](./src/demo.ts)).

## The model

From the shared catalog ([`../shared/catalog.ts`](../shared/catalog.ts)):

```ts
ai_credits: feature.credits({ name: "AI credits", unit: "credit", reset: "billing_period" }),
gpt_tokens: feature.metered({ name: "GPT tokens", unit: "token", reset: "never",
  creditCost: { ai_credits: 0.01 } }), // 0.01 credits per token
```

`gpt_tokens` is in no plan, so the `ai_credits` balance alone decides: Free has 100 credits
(10 000 tokens) per billing period, Pro 5 000, Business 50 000.

## The pattern

```ts
const r = await ent.reserve(org, "gpt_tokens", maxTokens, { ttl: "5m" });
if (!r.allowed) return upgrade(r); // 402: r.unlockedBy = ["pro", "business"]
try {
  const answer = await callModel(prompt);
  await ent.settle(r.reservation!.id, answer.usage.totalTokens); // refunds the unused part
} catch (error) {
  await ent.cancelReservation(r.reservation!.id); // the call failed: give it all back
  throw error;
}
```

Reservations that are never settled (a crashed worker) expire after their `ttl` and are released
by `ent.sweep()` — or by the panel, with `sweepInterval`.

## Run it

```bash
bun run examples:ai-credits --demo   # from the repo root; exits 0
```

## What the demo shows

1. Reserve 2 000 tokens (20 credits held), settle 1 500 → 15 credits, 5 refunded.
2. `onThreshold` fires **once** when usage crosses 80 % of the pool — not again at 86 %.
3. A reservation the pool can't cover is refused up front (`limit_reached`, `402`), taking nothing.
4. A failed model call cancels its reservation.
5. An unsettled reservation expires; `sweep()` releases it.
6. A one-off grant (a purchased credit pack) is drawn after the period allowance.
7. Upgrading to Pro raises the pool immediately.

The demo uses `createTestClock` from `@xtandard/entitlements/testing` only to fast-forward past a
reservation's TTL; your app passes nothing (`now` defaults to `Date.now`).
