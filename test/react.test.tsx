// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createEntitlementsReact,
  EntitlementsProvider,
  formatPlanPrice,
  Gate,
  PricingTable,
  UpgradePrompt,
  UsageMeter,
  useCustomer,
  useEntitlement,
  useEntitlements,
} from "../src/react/index.tsx";
import type { PortalData } from "../src/react/compute.ts";
import { catalog, portalData } from "./react-fixtures.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const free = () => portalData(async (ent) => void (await ent.consume("org_1", "api_calls", 800)));

describe("EntitlementsProvider", () => {
  test("fetches /api/portal/me with the portal token", async () => {
    const data = await free();
    const fetchMock = vi.fn(async () => json(data));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <EntitlementsProvider baseUrl="/billing/" token="entpt_abc">
        <Gate feature="api_calls" loading={<span>loading…</span>}>
          <span>calls ok</span>
        </Gate>
      </EntitlementsProvider>,
    );
    expect(screen.getByText("loading…")).toBeTruthy();
    expect(await screen.findByText("calls ok")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/billing/api/portal/me");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer entpt_abc");
    expect(init.credentials).toBe("same-origin");
  });

  test("a token function is awaited (re-mint on expiry)", async () => {
    const data = await free();
    const fetchMock = vi.fn(async () => json(data));
    vi.stubGlobal("fetch", fetchMock);
    const token = vi.fn(async () => "entpt_fresh");
    render(
      <EntitlementsProvider baseUrl="" token={token} credentials="include">
        <Gate feature="api_calls">ok</Gate>
      </EntitlementsProvider>,
    );
    expect(await screen.findByText("ok")).toBeTruthy();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer entpt_fresh");
    expect(init.credentials).toBe("include");
  });

  test("errors are surfaced, last good data kept, onError called", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "Invalid portal token" }, 401)),
    );
    const onError = vi.fn();
    let ctx: ReturnType<typeof useEntitlements> | undefined;
    const Probe = () => {
      ctx = useEntitlements();
      return null;
    };
    render(
      <EntitlementsProvider baseUrl="/b" token="t" onError={onError}>
        <Probe />
      </EntitlementsProvider>,
    );
    await waitFor(() => expect(ctx?.loading).toBe(false));
    expect((ctx!.error as Error).message).toBe("Invalid portal token");
    expect(ctx?.data).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  test("non-JSON error bodies fall back to the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 502 })),
    );
    let ctx: ReturnType<typeof useEntitlements> | undefined;
    const Probe = () => {
      ctx = useEntitlements();
      return null;
    };
    render(
      <EntitlementsProvider baseUrl="/b">
        <Probe />
      </EntitlementsProvider>,
    );
    await waitFor(() => expect(ctx?.error).toBeTruthy());
    expect((ctx!.error as Error).message).toBe("HTTP 502");
  });

  test("initial data renders without fetching; refresh() uses the fetcher", async () => {
    const before = await free();
    const after = await portalData(
      async (ent) => void (await ent.subscribe("org_1", { plan: "pro" })),
    );
    const fetcher = vi.fn(async () => after);
    let ctx: ReturnType<typeof useEntitlements> | undefined;
    const Probe = () => {
      ctx = useEntitlements();
      return (
        <Gate feature="export_pdf" fallback={<span>locked</span>}>
          unlocked
        </Gate>
      );
    };
    render(
      <EntitlementsProvider initial={before} fetcher={fetcher}>
        <Probe />
      </EntitlementsProvider>,
    );
    expect(screen.getByText("locked")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    await act(() => ctx!.refresh());
    expect(screen.getByText("unlocked")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test("refresh() with no source just settles", async () => {
    let ctx: ReturnType<typeof useEntitlements> | undefined;
    const Probe = () => {
      ctx = useEntitlements();
      return null;
    };
    render(
      <EntitlementsProvider>
        <Probe />
      </EntitlementsProvider>,
    );
    expect(ctx?.loading).toBe(true);
    await act(() => ctx!.refresh());
    expect(ctx?.loading).toBe(false);
    expect(ctx?.checkout).toBeUndefined();
  });

  test("refreshInterval polls", async () => {
    vi.useFakeTimers();
    try {
      const data = await free();
      const fetcher = vi.fn(async () => data);
      render(
        <EntitlementsProvider fetcher={fetcher} refreshInterval={1_000}>
          <span />
        </EntitlementsProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("hooks outside a provider throw", () => {
    const Bad = () => {
      useEntitlement("x");
      return null;
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow(/within <EntitlementsProvider>/);
  });
});

describe("useEntitlement / useCustomer", () => {
  test("numeric state + amount", async () => {
    const data = await free();
    const seen: Array<ReturnType<typeof useEntitlement>> = [];
    const Probe = ({ amount }: { amount: number }) => {
      seen.push(useEntitlement("api_calls", { amount }));
      return null;
    };
    const { rerender } = render(
      <EntitlementsProvider initial={data}>
        <Probe amount={100} />
      </EntitlementsProvider>,
    );
    expect(seen.at(-1)).toMatchObject({ allowed: true, used: 800, limit: 1_000, remaining: 200 });
    rerender(
      <EntitlementsProvider initial={data}>
        <Probe amount={300} />
      </EntitlementsProvider>,
    );
    expect(seen.at(-1)).toMatchObject({ allowed: false, unlockedBy: ["pro", "business"] });
  });

  test("useCustomer", async () => {
    const data = await portalData(async (ent) => {
      await ent.updateCustomer("org_1", { name: "Acme" });
      await ent.subscribe("org_1", { plan: "pro" });
    });
    let info: ReturnType<typeof useCustomer> | undefined;
    const Probe = () => {
      info = useCustomer();
      return null;
    };
    render(
      <EntitlementsProvider initial={data}>
        <Probe />
      </EntitlementsProvider>,
    );
    expect(info).toMatchObject({ name: "Acme", plan: "pro", planName: "Pro", status: "active" });
  });
});

describe("<Gate>", () => {
  test("children, fallback, render prop", async () => {
    const data = await free();
    render(
      <EntitlementsProvider initial={data}>
        <Gate feature="export_pdf" fallback={<span>upgrade please</span>}>
          <span>secret</span>
        </Gate>
        <Gate feature="api_calls" amount={500}>
          <span>too many</span>
        </Gate>
        <Gate feature="seats">{(s) => <span>{`seats ${s.used}/${s.limit}`}</span>}</Gate>
      </EntitlementsProvider>,
    );
    expect(screen.queryByText("secret")).toBeNull();
    expect(screen.getByText("upgrade please")).toBeTruthy();
    expect(screen.queryByText("too many")).toBeNull();
    expect(screen.getByText("seats 0/3")).toBeTruthy();
  });
});

describe("<UsageMeter>", () => {
  test("accessible progressbar with level and text", async () => {
    const data = await free();
    const { container } = render(
      <EntitlementsProvider initial={data}>
        <UsageMeter feature="api_calls" className="meter" />
      </EntitlementsProvider>,
    );
    const bar = screen.getByRole("progressbar", { name: "API calls" });
    expect(bar.getAttribute("aria-valuenow")).toBe("800");
    expect(bar.getAttribute("aria-valuemax")).toBe("1000");
    const root = container.querySelector(".meter")!;
    expect(root.getAttribute("data-level")).toBe("warn");
    expect(root.getAttribute("data-state")).toBe("allowed");
    expect(screen.getByText("800 / 1,000")).toBeTruthy();
    expect((container.querySelector("[data-part=fill]") as HTMLElement).style.width).toBe("80%");
    expect(container.querySelector("[data-part=reset] time")?.getAttribute("dateTime")).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });

  test("unlimited, hidden text, custom label, loading", async () => {
    const data = await portalData(async (ent) => {
      await ent.override("org_1", { feature: "api_calls", limit: null, reason: "comp" });
      await ent.consume("org_1", "api_calls", 1234);
    });
    const { container } = render(
      <EntitlementsProvider initial={data}>
        <UsageMeter feature="api_calls" label="Calls" hideText />
      </EntitlementsProvider>,
    );
    const bar = screen.getByRole("progressbar", { name: "Calls" });
    expect(bar.getAttribute("aria-valuetext")).toBe("1,234 used, unlimited");
    expect(bar.getAttribute("aria-valuemax")).toBeNull();
    expect(container.querySelector("[data-level=unlimited]")).toBeTruthy();
    expect(container.querySelector("[data-part=text]")).toBeNull();
    cleanup();
    render(
      <EntitlementsProvider>
        <UsageMeter feature="api_calls" />
      </EntitlementsProvider>,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("Loading");
  });
});

describe("<PricingTable>", () => {
  test("from the provider: current plan marked, relations, onSelect", async () => {
    const data = await portalData(
      async (ent) => void (await ent.subscribe("org_1", { plan: "pro" })),
    );
    const onSelect = vi.fn();
    const { container } = render(
      <EntitlementsProvider initial={data}>
        <PricingTable onSelect={onSelect} />
      </EntitlementsProvider>,
    );
    const pro = screen.getByRole("article", { name: "Pro plan" });
    expect(pro.getAttribute("data-current")).toBe("true");
    expect(pro.getAttribute("data-highlight")).toBe("true");
    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-part=action]");
    expect([...buttons].map((b) => [b.textContent, b.dataset.relation, b.disabled])).toEqual([
      ["Downgrade", "downgrade", false],
      ["Current plan", "current", true],
      ["Upgrade", "upgrade", false],
    ]);
    fireEvent.click(screen.getByText("Upgrade"));
    expect(onSelect).toHaveBeenCalledWith("business");
    expect(screen.getAllByText("14-day free trial")).toHaveLength(1);
    expect(screen.getAllByText("$29 / month")).toHaveLength(1);
  });

  test("from a catalog, no provider, custom labels, group filter", () => {
    render(
      <PricingTable
        catalog={catalog}
        onSelect={() => {}}
        actionLabel={(p, rel) => `${rel}:${p.key}`}
        group="base"
      />,
    );
    expect(screen.getByText("choose:free")).toBeTruthy();
    expect(screen.getByText("choose:business")).toBeTruthy();
    expect(screen.queryAllByRole("article")).toHaveLength(3);
    cleanup();
    render(<PricingTable catalog={catalog} group="nope" />);
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  test("renders nothing without data", () => {
    const { container } = render(<PricingTable />);
    expect(container.innerHTML).toBe("");
  });

  test("formatPlanPrice", () => {
    expect(formatPlanPrice({ price: [] })).toBe("Free");
    expect(formatPlanPrice({ price: [{ amount: 0, currency: "usd" }] })).toBe("Free");
    expect(formatPlanPrice({ price: [{ amount: 0, currency: "usd", label: "Custom" }] })).toBe(
      "Custom",
    );
    expect(formatPlanPrice({ price: [{ amount: 1999, currency: "eur", interval: "year" }] })).toBe(
      "€19.99 / year",
    );
    expect(
      formatPlanPrice({ price: [{ amount: 500, currency: "usd", interval: "one_time" }] }),
    ).toBe("$5");
  });
});

describe("<UpgradePrompt>", () => {
  test("nothing when allowed or loading", async () => {
    const data = await free();
    const { container } = render(
      <EntitlementsProvider initial={data}>
        <UpgradePrompt feature="api_calls" />
      </EntitlementsProvider>,
    );
    expect(container.innerHTML).toBe("");
  });

  test("not-in-plan message, onUpgrade with the cheapest plan", async () => {
    const data = await free();
    const onUpgrade = vi.fn();
    const { container } = render(
      <EntitlementsProvider initial={data}>
        <UpgradePrompt feature="export_pdf" onUpgrade={onUpgrade} />
      </EntitlementsProvider>,
    );
    expect(screen.getByText("Upgrade to Pro to use PDF export.")).toBeTruthy();
    expect(container.querySelector("[data-reason=plan]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(onUpgrade).toHaveBeenCalledWith("pro");
  });

  test("limit message; render prop; no button without a handler", async () => {
    const data = await free();
    render(
      <EntitlementsProvider initial={data}>
        <UpgradePrompt feature="api_calls" amount={500} />
        <UpgradePrompt feature="sso">{({ planName }) => <em>Get {planName}</em>}</UpgradePrompt>
      </EntitlementsProvider>,
    );
    expect(
      screen.getByText("You've reached your API calls limit. Upgrade to Pro for more."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Get Business")).toBeTruthy();
  });

  test("default action: portal checkout link-out", async () => {
    const data: PortalData = await free();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, href: "http://app.test/settings", assign });
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/api/portal/me") ? json(data) : json({ url: "https://checkout.test/s/1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <EntitlementsProvider baseUrl="/billing" token="entpt_x">
        <UpgradePrompt feature="export_pdf" />
      </EntitlementsProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Pro" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.test/s/1"));
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/billing/api/portal/checkout");
    expect(JSON.parse(init.body as string)).toEqual({
      plan: "pro",
      successUrl: "http://app.test/settings",
      cancelUrl: "http://app.test/settings",
    });
  });

  test("a failed checkout re-enables the button", async () => {
    const data = await free();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/api/portal/me") ? json(data) : json({ error: "no billing" }, 404),
      ),
    );
    render(
      <EntitlementsProvider baseUrl="/billing" token="entpt_x">
        <UpgradePrompt feature="export_pdf" />
      </EntitlementsProvider>,
    );
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Upgrade to Pro" });
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});

test("createEntitlementsReact returns the same components, typed", async () => {
  const typed = createEntitlementsReact<typeof catalog>();
  expect(typed.Gate).toBe(Gate);
  expect(typed.EntitlementsProvider).toBe(EntitlementsProvider);
  const data = await free();
  let upload: number | undefined;
  const Probe = () => {
    upload = typed.useEntitlement("max_upload_mb").value;
    return null;
  };
  render(
    <typed.EntitlementsProvider initial={data}>
      <Probe />
    </typed.EntitlementsProvider>,
  );
  expect(upload).toBe(10);
});
