import { describe, expect, test } from "vitest";
import { basicAuth, hashPassword } from "../src/auth/basic.ts";

describe("basicAuth (entitlements defaults)", () => {
  test("challenge() defaults the realm to xtandard-entitlements", () => {
    const auth = basicAuth({ users: [{ username: "admin", password: "secret" }] });
    const response = auth.challenge?.(new Request("http://x/"));
    expect(response?.status).toBe(401);
    expect(response?.headers.get("WWW-Authenticate")).toBe('Basic realm="xtandard-entitlements"');
  });

  test("an explicit realm wins", () => {
    const auth = basicAuth({
      users: [{ username: "admin", password: "secret" }],
      realm: "Billing Admin",
    });
    const response = auth.challenge?.(new Request("http://x/"));
    expect(response?.headers.get("WWW-Authenticate")).toBe('Basic realm="Billing Admin"');
  });

  test("authenticates a hashed password through the entitlements entry", async () => {
    const auth = basicAuth({
      users: [{ username: "ops", passwordHash: await hashPassword("s3cret"), roles: ["admin"] }],
    });
    const request = new Request("http://x/", {
      headers: { authorization: `Basic ${btoa("ops:s3cret")}` },
    });
    expect(await auth.authenticate(request)).toMatchObject({ id: "ops", roles: ["admin"] });
  });
});
