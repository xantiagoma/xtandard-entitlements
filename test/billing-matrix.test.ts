import { lemonSqueezyDriver, paddleDriver, polarDriver, stripeDriver } from "./billing-fixtures.ts";
import { runTransitionMatrix } from "./billing-matrix.ts";

runTransitionMatrix("stripe", stripeDriver);
runTransitionMatrix("polar", polarDriver);
runTransitionMatrix("paddle", paddleDriver);
runTransitionMatrix("lemonsqueezy", () => lemonSqueezyDriver());
