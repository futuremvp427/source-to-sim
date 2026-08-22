import { describe, expect, it, vi } from "vitest";

import { probeKalshiCapability, probePmusCapability, type CapabilityRepository, type VenueCapabilityRow } from "./capability.server";

function fakeRepo(): CapabilityRepository & { rows: Map<string, VenueCapabilityRow> } {
  const rows = new Map<string, VenueCapabilityRow>();
  return {
    rows,
    async upsert(row) {
      rows.set(row.venue, { ...row, checkedAtIso: "2026-01-01T00:00:00Z" });
    },
    async get(venue) {
      return rows.get(venue) ?? null;
    },
  };
}

describe("FINAL BUILD Part 8/4: venue capability probing", () => {
  it("PM-US: both discovery and orderbook available -> persists a fully-capable row", async () => {
    const repo = fakeRepo();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/v1/events")) {
        return new Response(JSON.stringify({ events: [{ markets: [{ slug: "test-slug" }] }] }), { status: 200 });
      }
      if (u.includes("/v1/markets/test-slug/book")) {
        return new Response(JSON.stringify({ bids: [], offers: [] }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${u}`);
    });
    const row = await probePmusCapability({ fetchImpl: fetchImpl as unknown as typeof fetch, repo });
    expect(row.discoveryAvailable).toBe(true);
    expect(row.orderbookAvailable).toBe(true);
    expect(repo.rows.get("PMUS")?.venue).toBe("PMUS"); // persisted via repo.upsert, not just returned
    expect(repo.rows.get("PMUS")?.orderbookAvailable).toBe(true);
  });

  it("PM-US: discovery works but orderbook now returns 401 -> discoveryAvailable true, orderbookAvailable false, system continues (never throws)", async () => {
    const repo = fakeRepo();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/v1/events")) return new Response(JSON.stringify({ events: [{ markets: [{ slug: "test-slug" }] }] }), { status: 200 });
      if (u.includes("/book")) return new Response("Unauthorized", { status: 401 });
      throw new Error(`unexpected URL: ${u}`);
    });
    const row = await probePmusCapability({ fetchImpl: fetchImpl as unknown as typeof fetch, repo });
    expect(row.discoveryAvailable).toBe(true);
    expect(row.orderbookAvailable).toBe(false);
    expect(row.detail).toMatch(/401/);
  });

  it("PM-US: discovery itself fails -> both discovery and orderbook reported unavailable, no orderbook probe even attempted", async () => {
    const repo = fakeRepo();
    const fetchImpl = vi.fn(async () => new Response("error", { status: 500 }));
    const row = await probePmusCapability({ fetchImpl: fetchImpl as unknown as typeof fetch, repo });
    expect(row.discoveryAvailable).toBe(false);
    expect(row.orderbookAvailable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never attempted the orderbook probe
  });

  it("a network throw (not just a bad status) is captured as unavailable, never propagated", async () => {
    const repo = fakeRepo();
    const fetchImpl = vi.fn(async () => {
      throw new Error("DNS resolution failed");
    });
    const row = await probePmusCapability({ fetchImpl: fetchImpl as unknown as typeof fetch, repo });
    expect(row.discoveryAvailable).toBe(false);
    expect(row.detail).toMatch(/DNS/);
  });

  it("Kalshi: full capability probe mirrors PM-US's shape", async () => {
    const repo = fakeRepo();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/markets?series_ticker")) return new Response(JSON.stringify({ markets: [{ ticker: "KXMLBGAME-1-NYY" }] }), { status: 200 });
      if (u.includes("/orderbook")) return new Response(JSON.stringify({ orderbook_fp: {} }), { status: 200 });
      throw new Error(`unexpected URL: ${u}`);
    });
    const row = await probeKalshiCapability({ fetchImpl: fetchImpl as unknown as typeof fetch, repo });
    expect(row.venue).toBe("KALSHI");
    expect(row.discoveryAvailable).toBe(true);
    expect(row.orderbookAvailable).toBe(true);
  });

  it("Kalshi: orderbook now requires auth (401) while discovery stays public -- exactly the documented-inconsistency scenario Part 8 warns about", async () => {
    const repo = fakeRepo();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/markets?series_ticker")) return new Response(JSON.stringify({ markets: [{ ticker: "KXMLBGAME-1-NYY" }] }), { status: 200 });
      if (u.includes("/orderbook")) return new Response("Unauthorized", { status: 401 });
      throw new Error(`unexpected URL: ${u}`);
    });
    const row = await probeKalshiCapability({ fetchImpl: fetchImpl as unknown as typeof fetch, repo });
    expect(row.discoveryAvailable).toBe(true);
    expect(row.orderbookAvailable).toBe(false);
  });
});
