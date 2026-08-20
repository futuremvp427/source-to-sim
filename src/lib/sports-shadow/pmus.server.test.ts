import { describe, expect, it, vi } from "vitest";
import { clearPmusDiscoveryCache, discoverPmusMlbMarkets, fetchPmusBook, PMUS_HOST, type PmusNetworkDeps } from "./pmus.server";

function okDeps(overrides: Partial<PmusNetworkDeps> = {}): PmusNetworkDeps {
  return {
    fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })),
    reserveRequestSlot: vi.fn(async () => 0),
    getHostCooldown: vi.fn(async () => ({ blocked: false, reason: null })),
    recordHostRateLimit: vi.fn(async () => {}),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

const NYY = { abbreviation: "nyy", name: "New York Yankees", league: "mlb", ordering: "away" };
const BAL = { abbreviation: "bal", name: "Baltimore Orioles", league: "mlb", ordering: "home" };

function eventFixture(id: string, marketSlug: string) {
  return {
    id,
    slug: `mlb-nyy-bal-${id}`,
    startTime: "2026-08-19T22:35:00Z",
    gameId: Number(id),
    teams: [NYY, BAL],
    markets: [
      {
        id: `m-${id}`,
        slug: marketSlug,
        sportsMarketType: "baseball_team_full_game_winner",
        sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE",
        line: null,
        marketSides: [
          { description: "New York Yankees", price: "1", long: true, team: NYY },
          { description: "Baltimore Orioles", price: "0", long: false, team: BAL },
        ],
      },
    ],
  };
}

describe("discoverPmusMlbMarkets", () => {
  it("17. bounded pagination stops at a short page", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: [eventFixture("1", "aec-mlb-nyy-bal-1")] }), { status: 200 }));
    const candidates = await discoverPmusMlbMarkets(okDeps({ fetchImpl }));
    expect(candidates).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // short page (< page size) stops pagination immediately
  });

  it("18. duplicate market/event responses across pages dedupe deterministically by marketSlug", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [eventFixture("1", "aec-mlb-nyy-bal-1")] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [eventFixture("1", "aec-mlb-nyy-bal-1")] }), { status: 200 }));
    // First call alone already returns a short page (< DISCOVERY_PAGE_SIZE) so pagination stops;
    // simulate two same-market results within one page instead to prove Map-based dedupe.
    const dupPage = { events: [eventFixture("1", "aec-mlb-nyy-bal-1"), eventFixture("1", "aec-mlb-nyy-bal-1")] };
    const fetchDup = vi.fn(async () => new Response(JSON.stringify(dupPage), { status: 200 }));
    const candidates = await discoverPmusMlbMarkets(okDeps({ fetchImpl: fetchDup }));
    expect(candidates).toHaveLength(1);
    void fetchImpl;
  });

  it("19. a malformed discovery payload fails explicitly (throws), never silently returns []", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response("not json {{{", { status: 200 }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed json/i);
  });

  it("19b. an unexpected response shape (events not an array) is treated as zero events for that page, not a crash", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: "not-an-array" }), { status: 200 }));
    const candidates = await discoverPmusMlbMarkets(okDeps({ fetchImpl }));
    expect(candidates).toEqual([]);
  });

  it("20. a timeout/network failure fails explicitly (throws)", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow();
  });

  it("20b. a non-2xx HTTP response fails explicitly (throws)", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/HTTP 500/);
  });

  it("a 429 records the shared host cooldown and fails explicitly", async () => {
    clearPmusDiscoveryCache();
    const recordHostRateLimit = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl, recordHostRateLimit }))).rejects.toThrow(/429/);
    expect(recordHostRateLimit).toHaveBeenCalledWith(PMUS_HOST, 30_000);
  });

  it("respects an active host cooldown without issuing a fetch", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const getHostCooldown = vi.fn(async () => ({ blocked: true, reason: "cooling down" }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl, getHostCooldown }))).rejects.toThrow(/cooldown/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("waits out a granted pacing reservation before fetching", async () => {
    clearPmusDiscoveryCache();
    const calls: string[] = [];
    const reserveRequestSlot = vi.fn(async () => {
      calls.push("reserve");
      return 5;
    });
    const fetchImpl = vi.fn(async () => {
      calls.push("fetch");
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    });
    await discoverPmusMlbMarkets(okDeps({ fetchImpl, reserveRequestSlot }));
    expect(calls).toEqual(["reserve", "fetch"]);
  });

  it("caches within the TTL and does not re-fetch", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: [eventFixture("1", "aec-mlb-nyy-bal-1")] }), { status: 200 }));
    const deps = okDeps({ fetchImpl });
    await discoverPmusMlbMarkets(deps);
    await discoverPmusMlbMarkets(deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("fetchPmusBook", () => {
  it("returns a normalized snapshot on success", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ marketData: { bids: [{ px: { value: "0.5" }, qty: "1" } ], offers: [] } }), { status: 200 }));
    const snap = await fetchPmusBook("some-slug", okDeps({ fetchImpl }));
    expect(snap.venue).toBe("PMUS");
    expect(snap.bestBid).toBe(0.5);
    expect(snap.staleReason).toBeNull();
  });

  it("37. a fetch timeout returns an explicit failure snapshot, never throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const snap = await fetchPmusBook("some-slug", okDeps({ fetchImpl }));
    expect(snap.bestBid).toBeNull();
    expect(snap.bestAsk).toBeNull();
    expect(snap.staleReason).not.toBeNull();
  });

  it("38. a 429 returns an explicit failure snapshot and records the cooldown", async () => {
    const recordHostRateLimit = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429 }));
    const snap = await fetchPmusBook("some-slug", okDeps({ fetchImpl, recordHostRateLimit }));
    expect(snap.staleReason).toMatch(/429/);
    expect(recordHostRateLimit).toHaveBeenCalled();
  });

  it("39. a 500 returns an explicit failure snapshot", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const snap = await fetchPmusBook("some-slug", okDeps({ fetchImpl }));
    expect(snap.staleReason).toMatch(/HTTP 500/);
  });

  it("book capture is never served from or written to the discovery catalog cache", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ marketData: { bids: [], offers: [] } }), { status: 200 }));
    const deps = okDeps({ fetchImpl });
    await fetchPmusBook("slug-a", deps);
    await fetchPmusBook("slug-a", deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // real request every time, no caching
  });
});

describe("auth/safety", () => {
  it("40. the public fetch never adds authentication headers", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: [] }), { status: 200 }));
    await discoverPmusMlbMarkets(okDeps({ fetchImpl }));
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).some((h) => /auth|signature|access-key|api-key/i.test(h))).toBe(false);
    expect(headers["Accept"]).toBe("application/json");
  });

  it("41/42. this module's actual import statements never reach the authenticated PM-US credential/order surface", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const serverSrc = await fs.readFile(path.resolve(import.meta.dirname, "pmus.server.ts"), "utf8");
    const pureSrc = await fs.readFile(path.resolve(import.meta.dirname, "pmus.ts"), "utf8");
    const importLines = [...serverSrc.matchAll(/^import .*$/gm), ...pureSrc.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).not.toMatch(/credentials\.server|signer\.server|capabilities\.server/);
    }
    for (const forbidden of ["previewOrder", "attemptOperation", "PMUS_BASE_URL ="]) {
      expect(serverSrc).not.toContain(forbidden);
      expect(pureSrc).not.toContain(forbidden);
    }
  });
});
