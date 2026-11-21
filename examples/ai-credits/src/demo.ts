/**
 * AI credits: meter LLM tokens against a prepaid credit pool with reserve /
 * settle, and alert on usage thresholds.
 *
 *   bun run demo     # or, from the repo root: bun run examples:ai-credits --demo
 *
 * The catalog (../../shared/catalog.ts) says `gpt_tokens` costs 0.01
 * `ai_credits` per token and is in no plan, so the credit balance alone
 * decides: free has 100 credits (= 10 000 tokens) per billing period, Pro 5 000.
 * The cost of an LLM call is only known afterwards, so the app reserves an
 * upper bound first and settles the actual usage — the unused part is refunded.
 */
import { createEntitlements, type ThresholdEvent } from "@xtandard/entitlements";
import { createMemoryStorage } from "@xtandard/entitlements/storage/memory";
import { createTestClock } from "@xtandard/entitlements/testing";
import { catalog } from "../../shared/catalog.ts";
import { equal, info, ok, runDemo, step } from "../../shared/demo-kit.ts";

/** A stand-in for your LLM client: answers with a deterministic token count (`null` = crash). */
async function callModel(prompt: string, tokens: number | null) {
  if (tokens === null) throw new Error("upstream 503");
  return { text: `(answer to "${prompt}")`, usage: { totalTokens: tokens } };
}

runDemo("AI credits × @xtandard/entitlements", async () => {
  // A controllable clock, only so the demo can fast-forward past a reservation's TTL.
  const clock = createTestClock("2026-11-21T09:00:00Z");
  const alerts: ThresholdEvent[] = [];
  const ent = createEntitlements({
    catalog,
    storage: createMemoryStorage(),
    now: clock.now,
    // Fires once per period per threshold (default 80 % and 100 %) — wire it to
    // email, Slack or @xtandard/webhooks. Fire-and-forget: never on the decision path.
    onThreshold: (e) => {
      alerts.push(e);
      console.log(
        `   🔔 ${e.customer}: ${e.feature} at ${e.threshold * 100}% (${e.used} / ${e.limit})`,
      );
    },
  });
  const org = "org_startup"; // on the free plan: 100 AI credits
  // Your signup flow creates the customer (name + email show up in the admin panel).
  await ent.updateCustomer(org, { name: "Startup Ltd.", email: "founders@startup.test" });
  const credits = async () => (await ent.entitlements(org)).features.ai_credits!;

  /** The pattern: reserve an upper bound → call the model → settle the actual usage. */
  async function ask(prompt: string, maxTokens: number, actualTokens: number | null) {
    const r = await ent.reserve(org, "gpt_tokens", maxTokens, { ttl: "5m" });
    if (!r.allowed) return { refused: r };
    try {
      const answer = await callModel(prompt, actualTokens);
      await ent.settle(r.reservation!.id, answer.usage.totalTokens);
      return { answer };
    } catch (error) {
      await ent.cancelReservation(r.reservation!.id); // the call failed: give everything back
      throw error;
    }
  }

  step("Reserve an upper bound, settle the actual usage");
  const r = await ent.reserve(org, "gpt_tokens", 2_000, { ttl: "5m" });
  equal(r.allowed, true, "reserve 2 000 tokens");
  equal((await credits()).used, 20, "20 credits held while the call runs");
  const answer = await callModel("summarize Q3", 1_500);
  await ent.settle(r.reservation!.id, answer.usage.totalTokens);
  equal((await credits()).used, 15, "settled at 1 500 tokens → 15 credits, 5 refunded");

  step("Thresholds fire once per period");
  await ask("draft the launch post", 6_000, 6_000); // 15 + 60 = 75 credits
  equal(alerts.length, 0, "75 % used — no alert yet");
  await ask("translate the docs", 1_000, 1_000); // 85 credits
  equal(
    alerts.map((a) => a.threshold),
    [0.8],
    "crossing 80 % alerts once",
  );
  await ask("one more", 100, 100); // 86 credits
  equal(alerts.length, 1, "no repeat at 86 %");

  step("When the pool can't cover the reservation, the request is refused up front");
  const refused = await ask("write a novel", 5_000, 5_000); // needs 50 credits, 14 left
  ok("refused" in refused, "refused before calling the model");
  const d = refused.refused!;
  equal([d.reason, d.denial], ["limit_reached", "payment_required"], "402: an upgrade would help");
  equal(d.unlockedBy, ["pro", "business"], "unlockedBy");
  equal((await credits()).used, 86, "a refused reservation takes nothing");

  step("A crashed call gives its reservation back");
  const crashed = await ask("flaky", 1_000, null).catch((error: Error) => error);
  ok(crashed instanceof Error, `the model call failed (${(crashed as Error).message})`);
  equal((await credits()).used, 86, "cancelReservation released the 10 credits it held");

  step("Reservations nobody settles expire");
  await ent.reserve(org, "gpt_tokens", 500, { ttl: "5m" }); // the worker died mid-call
  equal((await credits()).used, 91, "5 credits held");
  clock.advance("6m");
  equal((await ent.sweep()).released, 1, "sweep() released the expired reservation");
  equal((await credits()).used, 86, "back to 86");
  info('(the panel can run the sweep for you: entitlementsPanel({ sweepInterval: "1m" }))');

  step("Top up: a one-off credit pack (an operator grant)");
  await ent.grant(org, { feature: "ai_credits", amount: 500, reason: "credit pack #1" });
  const big = await ask("write a novel", 5_000, 4_200);
  ok("answer" in big, "allowed now");
  const pool = await credits();
  equal([pool.used, pool.limit], [128, 600], "allowance used first, then the grant");

  step("Upgrading raises the pool immediately");
  await ent.subscribe(org, { plan: "pro" });
  equal((await credits()).limit, 5_000 + 500, "Pro: 5 000 per period + the 500 granted");

  await ent.close();
});
