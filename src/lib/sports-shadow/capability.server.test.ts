import { describe, expect, it, vi } from "vitest";

import { CAPABILITY_PROBE_MAX_AGE_MS, probeKalshiCapability, probePmusCapability, refreshVenueCapabilityIfStale, type CapabilityRepository, type VenueCapabilityRow } from "./capability.server";

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

describe("RECONCILIATION FIX (2026-08-22): refreshVenueCapabilityIfStale test coverage -- missing from the live 509d053f fix, required by the reconciliation mission's own test list (item 10: capability refresh persists both rows, stale gate works)", () => {
  const okFetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/v1/events")) return new Response(JSON.stringify({ events: [{ markets: [{ slug: "s" }] }] }), { status: 200 });
    if (u.includes("/v1/markets/s/book")) return new Response(JSON.stringify({}), { status: 200 });
    if (u.includes("/markets?series_ticker")) return new Response(JSON.stringify({ markets: [{ ticker: "t" }] }), { status: 200 });
    if (u.includes("/orderbook")) return new Response(JSON.stringify({}), { status: 200 });
    throw new Error(`unexpected URL: ${u}`);
  });

  it("probes and persists BOTH venues when no row exists yet for either", async () => {
    const repo = fakeRepo();
    await refreshVenueCapabilityIfStale(Date.parse("2026-08-22T20:00:00Z"), { fetchImpl: okFetch as unknown as typeof fetch, repo });
    expect(repo.rows.has("PMUS")).toBe(true);
    expect(repo.rows.has("KALSHI")).toBe(true);
  });

  it("skips a venue whose row is still fresh (within CAPABILITY_PROBE_MAX_AGE_MS), never re-probing every cycle", async () => {
    const repo = fakeRepo();
    const nowMs = Date.parse("2026-08-22T20:00:00Z");
    await repo.upsert({ venue: "PMUS", discoveryAvailable: true, orderbookAvailable: true, detail: null });
    repo.rows.set("PMUS", { ...repo.rows.get("PMUS")!, checkedAtIso: new Date(nowMs - 1_000).toISOString() }); // "just checked"
    let pmusProbed = false;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("v1/events")) pmusProbed = true;
      return okFetch(url);
    });
    await refreshVenueCapabilityIfStale(nowMs, { fetchImpl: fetchImpl as unknown as typeof fetch, repo });
    expect(pmusProbed).toBe(false); // PM-US skipped -- fresh
    expect(repo.rows.has("KALSHI")).toBe(true); // KALSHI still probed -- had no row at all
  });

  it("re-probes a venue once its row is stale (>= CAPABILITY_PROBE_MAX_AGE_MS old)", async () => {
    const repo = fakeRepo();
    const nowMs = Date.parse("2026-08-22T20:00:00Z");
    await repo.upsert({ venue: "PMUS", discoveryAvailable: true, orderbookAvailable: true, detail: null });
    repo.rows.set("PMUS", { ...repo.rows.get("PMUS")!, checkedAtIso: new Date(nowMs - CAPABILITY_PROBE_MAX_AGE_MS - 1).toISOString() });
    let pmusProbed = false;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("v1/events")) pmusProbed = true;
      return okFetch(url);
    });
    await refreshVenueCapabilityIfStale(nowMs, { fetchImpl: fetchImpl as unknown as typeof fetch, repo });
    expect(pmusProbed).toBe(true);
  });

  it("a PM-US repo.get failure never prevents Kalshi's own probe from running or persisting -- one venue's failure never blocks the other", async () => {
    const repo = fakeRepo();
    const originalGet = repo.get.bind(repo);
    repo.get = async (venue) => {
      if (venue === "PMUS") throw new Error("db unavailable for PMUS read");
      return originalGet(venue);
    };
    await refreshVenueCapabilityIfStale(Date.parse("2026-08-22T20:00:00Z"), { fetchImpl: okFetch as unknown as typeof fetch, repo });
    expect(repo.rows.has("KALSHI")).toBe(true);
  });

  it("a Kalshi persistence failure never prevents PM-US's own probe from having already run and persisted (mirror of the above)", async () => {
    const repo = fakeRepo();
    const originalUpsert = repo.upsert.bind(repo);
    repo.upsert = async (row) => {
      if (row.venue === "KALSHI") throw new Error("db unavailable for KALSHI write");
      return originalUpsert(row);
    };
    await refreshVenueCapabilityIfStale(Date.parse("2026-08-22T20:00:00Z"), { fetchImpl: okFetch as unknown as typeof fetch, repo });
    expect(repo.rows.has("PMUS")).toBe(true);
  });

  it("probes venues sequentially, never with concurrent fan-out (Cloudflare outbound connection discipline)", async () => {
    const repo = fakeRepo();
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const result = await okFetch(url);
      inFlight -= 1;
      return result;
    });
    await refreshVenueCapabilityIfStale(Date.parse("2026-08-22T20:00:00Z"), { fetchImpl: fetchImpl as unknown as typeof fetch, repo });
    expect(maxInFlight).toBe(1);
  });
});
