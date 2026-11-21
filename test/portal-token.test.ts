import { describe, expect, test } from "vitest";
import {
  createPortalToken,
  PORTAL_TOKEN_PREFIX,
  PortalTokenError,
  verifyPortalToken,
} from "../src/portal.ts";

const SECRET = "an-arbitrary-portal-secret";
const T0 = Date.parse("2026-11-20T12:00:00Z");

const b64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Craft a correctly signed token over an arbitrary payload string. */
async function craftToken(secret: string, payload: string): Promise<string> {
  const payloadPart = b64url(new TextEncoder().encode(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadPart)),
  );
  return `${PORTAL_TOKEN_PREFIX}${payloadPart}.${b64url(digest)}`;
}

describe("createPortalToken / verifyPortalToken", () => {
  test("round-trips the customer with the full portal scope and a 1h default expiry", async () => {
    const token = await createPortalToken(SECRET, "org_42", { now: T0 });
    expect(token.startsWith("entpt_")).toBe(true);
    expect(await verifyPortalToken(SECRET, token, { now: T0 })).toEqual({
      customer: "org_42",
      scope: ["portal:read", "portal:checkout", "portal:manage"],
      expiresAt: T0 + 3_600_000,
    });
  });

  test("custom expiry and narrowed (deduplicated) scope", async () => {
    const token = await createPortalToken(SECRET, "org_42", {
      now: T0,
      expiresIn: "15m",
      scope: ["portal:read", "portal:read"],
    });
    const claims = await verifyPortalToken(SECRET, token, { now: T0 });
    expect(claims.scope).toEqual(["portal:read"]);
    expect(claims.expiresAt).toBe(T0 + 900_000);
  });

  test("uses the real clock by default", async () => {
    const token = await createPortalToken(SECRET, "org_1");
    expect((await verifyPortalToken(SECRET, token)).customer).toBe("org_1");
  });

  test("expired tokens are rejected (at exactly exp, too)", async () => {
    const token = await createPortalToken(SECRET, "org_1", { now: T0, expiresIn: "1m" });
    await expect(verifyPortalToken(SECRET, token, { now: T0 + 60_000 })).rejects.toThrow(/expired/);
  });

  test("a different secret, a tampered payload or signature → signature mismatch", async () => {
    const token = await createPortalToken(SECRET, "org_1");
    await expect(verifyPortalToken("other", token)).rejects.toThrow(/signature mismatch/);
    const [payload, sig] = token.slice(PORTAL_TOKEN_PREFIX.length).split(".") as [string, string];
    const forgedPayload = b64url(
      new TextEncoder().encode(
        JSON.stringify({ customer: "org_2", exp: 9e15, scope: ["portal:read"] }),
      ),
    );
    await expect(
      verifyPortalToken(SECRET, `${PORTAL_TOKEN_PREFIX}${forgedPayload}.${sig}`),
    ).rejects.toThrow(/signature mismatch/);
    await expect(
      verifyPortalToken(SECRET, `${PORTAL_TOKEN_PREFIX}${payload}.${sig.slice(0, -2)}AA`),
    ).rejects.toThrow(PortalTokenError);
  });

  test("malformed tokens", async () => {
    await expect(verifyPortalToken(SECRET, "whpt_abc.def")).rejects.toThrow(/prefix/);
    await expect(verifyPortalToken(SECRET, "entpt_abc")).rejects.toThrow(/malformed/);
    await expect(verifyPortalToken(SECRET, "entpt_.x")).rejects.toThrow(/malformed/);
    await expect(verifyPortalToken(SECRET, "entpt_a.b.c")).rejects.toThrow(/malformed/);
    await expect(verifyPortalToken(SECRET, "entpt_abc.!!!")).rejects.toThrow(/malformed signature/);
  });

  test("signed but invalid claims are rejected", async () => {
    const cases: Array<[string, RegExp]> = [
      ["not json", /malformed payload/],
      [JSON.stringify({ exp: T0 + 1, scope: ["portal:read"] }), /missing customer/],
      [JSON.stringify({ customer: "", exp: T0 + 1, scope: ["portal:read"] }), /missing customer/],
      [JSON.stringify({ customer: "c", scope: ["portal:read"] }), /missing expiry/],
      [JSON.stringify({ customer: "c", exp: "soon", scope: ["portal:read"] }), /missing expiry/],
      [JSON.stringify({ customer: "c", exp: T0 + 1 }), /invalid scope/],
      [JSON.stringify({ customer: "c", exp: T0 + 1, scope: [] }), /invalid scope/],
      [JSON.stringify({ customer: "c", exp: T0 + 1, scope: ["customer:delete"] }), /invalid scope/],
    ];
    for (const [payload, error] of cases) {
      const token = await craftToken(SECRET, payload);
      await expect(verifyPortalToken(SECRET, token, { now: T0 }), payload).rejects.toThrow(error);
    }
  });

  test("minting validates its input", async () => {
    await expect(createPortalToken("", "c")).rejects.toThrow(/secret/);
    await expect(createPortalToken(SECRET, "")).rejects.toThrow(/customer/);
    await expect(
      createPortalToken(SECRET, "c", { scope: ["customer:delete" as never] }),
    ).rejects.toThrow(/Invalid portal scope/);
    await expect(createPortalToken(SECRET, "c", { scope: [] })).rejects.toThrow(PortalTokenError);
  });

  test("errors are PortalTokenErrors (→ 401)", async () => {
    const err = await verifyPortalToken(SECRET, "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalTokenError);
    expect((err as Error).name).toBe("PortalTokenError");
  });
});
