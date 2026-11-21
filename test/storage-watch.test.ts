import { describe, expect, test, vi } from "vitest";
import { pgListenNotify, withWatch, type PgNotificationClient } from "../src/storage/watch.ts";
import { createMemoryStorage } from "../src/storage/memory.ts";

describe("pgListenNotify", () => {
  function fakeClient() {
    const queries: string[] = [];
    let handler: ((msg: { channel: string; payload?: string }) => void) | undefined;
    const client: PgNotificationClient = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
      }),
      on: (_e, listener) => {
        handler = listener;
      },
      removeListener: () => {
        handler = undefined;
      },
    };
    return {
      client,
      queries,
      emit: (channel: string, payload?: string) => handler?.({ channel, payload }),
    };
  }

  test("defaults to the xtandard_entitlements channel", async () => {
    const { client, queries } = fakeClient();
    const storage = withWatch(createMemoryStorage(), pgListenNotify(client));
    const off = await storage.watch("ent/", () => {});
    expect(queries).toEqual(['LISTEN "xtandard_entitlements"']);
    await off();
  });

  test("LISTENs, forwards matching-channel payloads, UNLISTENs on unsubscribe", async () => {
    const { client, queries, emit } = fakeClient();
    const storage = withWatch(createMemoryStorage(), pgListenNotify(client, "flags_ch"));

    const seen: string[] = [];
    const off = await storage.watch("ent/", (e) => seen.push(e.key));
    expect(queries.some((q) => q.includes(`LISTEN "flags_ch"`))).toBe(true);

    emit("flags_ch", "ent/a"); // forwarded
    emit("other_ch", "ent/b"); // wrong channel, ignored
    expect(seen).toEqual(["ent/a"]);

    await off();
    expect(queries.some((q) => q.includes(`UNLISTEN "flags_ch"`))).toBe(true);
  });
});
