import { describe, expect, test } from "vitest";
import { buildOpenApiDocument } from "../src/server/openapi.ts";
import { API_ROUTES } from "../src/server/routes.ts";

type Doc = {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, unknown> };
};

const doc = buildOpenApiDocument({ basePath: "/billing", title: "Acme" }) as unknown as Doc;

describe("openapi", () => {
  test("is OpenAPI 3.1 with the title and base path", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toMatchObject({ title: "Acme", version: "1" });
    expect(doc.servers).toEqual([{ url: "/billing" }]);
    const bare = buildOpenApiDocument() as unknown as Doc;
    expect(bare.servers).toEqual([{ url: "/" }]);
    expect(bare.info.title).toBe("@xtandard/entitlements");
  });

  test("documents every served route (and the config paths)", () => {
    for (const route of API_ROUTES) {
      const path = route.path.replace(/:([A-Za-z]+)/g, "{$1}");
      const op = doc.paths[path]?.[route.method.toLowerCase()];
      expect(op, `${route.method} ${route.path}`).toBeDefined();
      expect(op!.operationId).toBe(route.operationId);
    }
    expect(doc.paths["/config"]?.get).toBeDefined();
    expect(doc.paths["/api/config"]?.get).toBeDefined();
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("covers the HTTP_API.md contract", () => {
    const expected = [
      "GET /api/catalog",
      "GET /api/overview",
      "GET /api/customers",
      "GET /api/customers/{id}",
      "PATCH /api/customers/{id}",
      "DELETE /api/customers/{id}",
      "POST /api/customers/{id}/subscriptions",
      "PATCH /api/customers/{id}/subscriptions/{sid}",
      "POST /api/customers/{id}/subscriptions/{sid}/cancel",
      "DELETE /api/customers/{id}/subscriptions/{sid}",
      "POST /api/customers/{id}/trials",
      "POST /api/customers/{id}/grants",
      "DELETE /api/customers/{id}/grants/{gid}",
      "POST /api/customers/{id}/overrides",
      "DELETE /api/customers/{id}/overrides/{oid}",
      "PUT /api/customers/{id}/usage/{feature}",
      "DELETE /api/customers/{id}/usage/{feature}",
      "GET /api/customers/{id}/usage/{feature}/series",
      "GET /api/customers/{id}/activity",
      "GET /api/activity",
      "POST /api/plans/{plan}/migrate",
      "POST /api/reservations/sweep",
      "POST /api/customers/{id}/reconcile",
      "POST /api/v1/check",
      "POST /api/v1/consume",
      "POST /api/v1/release",
      "POST /api/v1/reserve",
      "POST /api/v1/settle",
      "GET /api/v1/entitlements/{customer}",
      "GET /api/portal/me",
      "POST /api/portal/checkout",
      "POST /api/portal/manage",
      "GET /config",
      "GET /api/config",
      "GET /api/openapi.json",
      "GET /api/pricing",
      "GET /healthcheck",
      "POST /webhooks/{provider}",
    ];
    const actual = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(actual.sort()).toEqual(expected.sort());
  });

  test("every $ref resolves to a component schema", () => {
    const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/(\w+)"/g)].map(
      (m) => m[1]!,
    );
    expect(refs.length).toBeGreaterThan(30);
    for (const name of refs) expect(doc.components.schemas[name], name).toBeDefined();
  });

  test("admin routes carry x-action and auth errors; public routes opt out of security", () => {
    const grant = doc.paths["/api/customers/{id}/grants"]!.post!;
    expect(grant["x-action"]).toBe("grant:write");
    expect(Object.keys(grant.responses as object)).toEqual(
      expect.arrayContaining(["201", "400", "401", "403", "404", "423"]),
    );
    expect(doc.paths["/api/pricing"]!.get!.security).toEqual([]);
    expect(doc.paths["/webhooks/{provider}"]!.post!.security).toEqual([]);
    const consume = doc.paths["/api/v1/consume"]!.post! as {
      parameters: Array<{ name: string; in: string }>;
    };
    expect(consume.parameters).toContainEqual(
      expect.objectContaining({ name: "idempotency-key", in: "header" }),
    );
    const del = doc.paths["/api/customers/{id}"]!.delete!;
    expect(Object.keys((del.responses as Record<string, { content?: unknown }>)["204"]!)).toEqual([
      "description",
    ]);
    const manage = doc.paths["/api/portal/manage"]!.post! as {
      requestBody: { required: boolean };
    };
    expect(manage.requestBody.required).toBe(false);
  });
});
