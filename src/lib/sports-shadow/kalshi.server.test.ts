import { describe, expect, it, vi } from "vitest";
import { clearKalshiDiscoveryCache, discoverKalshiMlbMarkets, fetchKalshiBook, KALSHI_HOST, MAX_PAGES_PER_SERIES, type KalshiNetworkDeps } from "./kalshi.server";
import { buildKalshiObservationPatch } from "./observation";
import { NO_OP_LEASE_CHECKPOINT } from "./sports-lease.server";

function okDeps(overrides: Partial<KalshiNetworkDeps> = {}): KalshiNetworkDeps {
  return {
    fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })),
    reserveRequestSlot: vi.fn(async () => 0),
    getHostCooldown: vi.fn(async () => ({ blocked: false, reason: null })),
    recordHostRateLimit: vi.fn(async () => {}),
    now: () => 1_700_000_000_000,
    checkpointLease: NO_OP_LEASE_CHECKPOINT,
    ...overrides,
  };
}

const EVENT = { event_ticker: "KXMLBGAME-1", series_ticker: "KXMLBGAME", title: "Minnesota vs San Diego" };
function market(ticker: string) {
  return { ticker, event_ticker: "KXMLBGAME-1", yes_sub_title: "San Diego", no_sub_title: "San Diego", status: "active" };
}

function routeByPath(handlers: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    for (const [key, body] of Object.entries(handlers)) {
      if (u.includes(key)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ markets: [], events: [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("discoverKalshiMlbMarkets", () => {
  it("only queries the three Phase-1 series, never KXMLBF5SPREAD/KXMLBF5TOTAL/other series", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ markets: [], events: [] }), { status: 200 })) as unknown as typeof fetch;
    await discoverKalshiMlbMarkets(okDeps({ fetchImpl }));
    const urls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.some((u) => u.includes("KXMLBGAME"))).toBe(true);
    expect(urls.some((u) => u.includes("KXMLBSPREAD"))).toBe(true);
    expect(urls.some((u) => u.includes("KXMLBTOTAL"))).toBe(true);
    expect(urls.some((u) => u.includes("F5"))).toBe(false);
  });

  it("13/14. cursor pagination is bounded and terminates on an empty cursor", async () => {
    clearKalshiDiscoveryCache();
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      call += 1;
      const u = String(url);
      if (u.includes("/markets")) {
        if (u.includes("cursor=")) return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
        return new Response(JSON.stringify({ markets: [market("KXMLBGAME-1-SD")], cursor: "next-page" }), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [EVENT], cursor: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    const candidates = await discoverKalshiMlbMarkets(okDeps({ fetchImpl }));
    expect(candidates.some((c) => c.marketTicker === "KXMLBGAME-1-SD")).toBe(true);
    // 2 pages of /markets for KXMLBGAME (2nd empty terminates) + 1 page /events, x3 series = bounded, not runaway.
    expect(call).toBeLessThan(30);
  });

  it("15. duplicate tickers across pages/series dedupe deterministically", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = routeByPath({
      "/markets": { markets: [market("KXMLBGAME-1-SD"), market("KXMLBGAME-1-SD")], cursor: "" },
      "/events": { events: [EVENT], cursor: "" },
    });
    const candidates = await discoverKalshiMlbMarkets(okDeps({ fetchImpl }));
    expect(candidates.filter((c) => c.marketTicker === "KXMLBGAME-1-SD")).toHaveLength(1);
  });

  it("16. a malformed discovery payload fails explicitly (throws)", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response("not json {{{", { status: 200 })) as unknown as typeof fetch;
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed json/i);
  });

  it("17. a timeout fails explicitly (throws)", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow();
  });

  it("18. a 429 fails explicitly and records the shared host cooldown", async () => {
    clearKalshiDiscoveryCache();
    const recordHostRateLimit = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "20" } }));
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl, recordHostRateLimit }))).rejects.toThrow(/429/);
    expect(recordHostRateLimit).toHaveBeenCalledWith(KALSHI_HOST, 20_000);
  });

  it("19. a 5xx fails explicitly", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 503 }));
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/HTTP 503/);
  });

  it("I5: `markets` missing on a /markets page throws a discovery failure", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/markets")) return new Response(JSON.stringify({ cursor: "" }), { status: 200 });
      return new Response(JSON.stringify({ events: [], cursor: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response.*markets/i);
  });

  it("I6: `markets` non-array on a /markets page throws a discovery failure", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/markets")) return new Response(JSON.stringify({ markets: "not-an-array", cursor: "" }), { status: 200 });
      return new Response(JSON.stringify({ events: [], cursor: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response.*markets/i);
  });

  it("I7: `events` missing on an /events page throws a discovery failure", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/markets")) return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      return new Response(JSON.stringify({ cursor: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response.*events/i);
  });

  it("I8: `events` non-array on an /events page throws a discovery failure", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/markets")) return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      return new Response(JSON.stringify({ events: {}, cursor: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response.*events/i);
  });

  it("a non-string cursor throws a discovery failure rather than being coerced", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/markets")) return new Response(JSON.stringify({ markets: [], cursor: 12345 }), { status: 200 });
      return new Response(JSON.stringify({ events: [], cursor: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response.*cursor/i);
  });

  it("I9: a genuinely empty `markets: []` / `events: []` page is valid and successful, not a malformed-response error", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = routeByPath({ "/markets": { markets: [], cursor: "" }, "/events": { events: [], cursor: "" } });
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).resolves.toEqual([]);
  });

  it("I10: a malformed SECOND page (after a valid first page) throws rather than returning the partial catalog accumulated so far", async () => {
    clearKalshiDiscoveryCache();
    let marketsPageCount = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/markets")) {
        marketsPageCount += 1;
        if (marketsPageCount === 1) {
          return new Response(JSON.stringify({ markets: [market("KXMLBGAME-1-SD")], cursor: "next-page" }), { status: 200 });
        }
        // Second page: malformed (markets not an array).
        return new Response(JSON.stringify({ markets: "not-an-array", cursor: "" }), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [EVENT], cursor: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response.*markets/i);
  });

  it("caches within the TTL and does not re-fetch", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = routeByPath({ "/markets": { markets: [market("KXMLBGAME-1-SD")], cursor: "" }, "/events": { events: [EVENT], cursor: "" } });
    const deps = okDeps({ fetchImpl });
    await discoverKalshiMlbMarkets(deps);
    const callsAfterFirst = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length;
    await discoverKalshiMlbMarkets(deps);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });

  it("respects an active host cooldown without issuing a fetch", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const getHostCooldown = vi.fn(async () => ({ blocked: true, reason: "cooling down" }));
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl, getHostCooldown }))).rejects.toThrow(/cooldown/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CANARY-3: a discovery 429 persists cooldown, suppresses same-host retries inside cooldown, and automatically resumes after expiry", async () => {
    clearKalshiDiscoveryCache();
    let now = 1_700_000_000_000;
    let blockedUntil = 0;
    let firstFetch = true;
    const fetchImpl = vi.fn(async () => {
      if (firstFetch) {
        firstFetch = false;
        return new Response("{}", { status: 429, headers: { "retry-after": "20" } });
      }
      return new Response(JSON.stringify({ markets: [], events: [], cursor: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    const getHostCooldown = vi.fn(async () =>
      blockedUntil > now ? { blocked: true, reason: `Retry-After until ${blockedUntil}` } : { blocked: false, reason: null },
    );
    const recordHostRateLimit = vi.fn(async (_host: string, retryAfterMs: number | null) => {
      blockedUntil = now + (retryAfterMs ?? 90_000);
    });

    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl, getHostCooldown, recordHostRateLimit, now: () => now }))).rejects.toThrow(/429/);
    expect(recordHostRateLimit).toHaveBeenCalledWith(KALSHI_HOST, 20_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl, getHostCooldown, recordHostRateLimit, now: () => now + 1_000 }))).rejects.toThrow(/cooldown/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = blockedUntil + 1;
    await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl, getHostCooldown, recordHostRateLimit, now: () => now }))).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(7); // first 429 + 3 series x (/markets + /events) after cooldown
  });

  describe("Task 12I / P2-P1: pagination truncation must fail closed, never cache a partial catalog", () => {
    /** Builds a fetchImpl where /markets (and, independently, /events) always returns one item plus a non-empty cursor -- i.e. upstream always claims there's more, page after page. */
    function alwaysMorePagesFetchImpl() {
      return vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/markets")) return new Response(JSON.stringify({ markets: [market("KXMLBGAME-1-SD")], cursor: "more" }), { status: 200 });
        return new Response(JSON.stringify({ events: [EVENT], cursor: "more" }), { status: 200 });
      }) as unknown as typeof fetch;
    }

    it("fewer than max pages with an empty cursor -> valid, no truncation error (baseline, already covered by test 13/14, re-asserted here for the boundary suite's own clarity)", async () => {
      clearKalshiDiscoveryCache();
      const fetchImpl = routeByPath({ "/markets": { markets: [market("KXMLBGAME-1-SD")], cursor: "" }, "/events": { events: [EVENT], cursor: "" } });
      await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).resolves.not.toThrow();
    });

    it("exactly MAX_PAGES_PER_SERIES pages, final page's cursor absent/empty -> valid complete result", async () => {
      clearKalshiDiscoveryCache();
      let marketsCalls = 0;
      const fetchImpl = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/markets")) {
          marketsCalls += 1;
          const isFinalPage = marketsCalls % MAX_PAGES_PER_SERIES === 0;
          return new Response(JSON.stringify({ markets: [market(`KXMLBGAME-1-P${marketsCalls}`)], cursor: isFinalPage ? "" : "more" }), { status: 200 });
        }
        return new Response(JSON.stringify({ events: [EVENT], cursor: "" }), { status: 200 });
      }) as unknown as typeof fetch;
      await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).resolves.not.toThrow();
      // 3 series x MAX_PAGES_PER_SERIES /markets pages each -- proves the loop actually ran the full budget, not fewer.
      expect(marketsCalls).toBe(3 * MAX_PAGES_PER_SERIES);
    });

    it("exactly MAX_PAGES_PER_SERIES pages, final page's cursor still present -> explicit truncation failure, not a returned/cached partial catalog", async () => {
      clearKalshiDiscoveryCache();
      const fetchImpl = alwaysMorePagesFetchImpl();
      await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/truncated/i);
    });

    it("the truncation-failing pagination call issues exactly MAX_PAGES_PER_SERIES page fetches for the failing endpoint, never more", async () => {
      clearKalshiDiscoveryCache();
      let marketsCalls = 0;
      const fetchImpl = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/markets")) {
          marketsCalls += 1;
          return new Response(JSON.stringify({ markets: [market("KXMLBGAME-1-SD")], cursor: "more" }), { status: 200 });
        }
        return new Response(JSON.stringify({ events: [EVENT], cursor: "" }), { status: 200 });
      }) as unknown as typeof fetch;
      await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/truncated/i);
      // The FIRST series' /markets pagination is what throws (deterministic series order) -- bounded at exactly MAX_PAGES_PER_SERIES, not runaway.
      expect(marketsCalls).toBe(MAX_PAGES_PER_SERIES);
    });

    it("truncation on /events (not just /markets) is caught the same way", async () => {
      clearKalshiDiscoveryCache();
      const fetchImpl = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/events")) return new Response(JSON.stringify({ events: [EVENT], cursor: "more" }), { status: 200 });
        return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      }) as unknown as typeof fetch;
      await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/truncated/i);
    });

    it("a genuinely empty final page (items.length === 0) at any point, even with a stray non-empty cursor, is treated as complete -- not a truncation failure", async () => {
      clearKalshiDiscoveryCache();
      const fetchImpl = routeByPath({ "/markets": { markets: [], cursor: "weird-but-empty-page" }, "/events": { events: [EVENT], cursor: "" } });
      await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).resolves.not.toThrow();
    });

    it("a truncation failure never poisons the discovery cache -- a subsequent call with a healthy complete response succeeds normally", async () => {
      clearKalshiDiscoveryCache();
      await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl: alwaysMorePagesFetchImpl() }))).rejects.toThrow(/truncated/i);

      const healthyFetchImpl = routeByPath({ "/markets": { markets: [market("KXMLBGAME-1-SD")], cursor: "" }, "/events": { events: [EVENT], cursor: "" } });
      const candidates = await discoverKalshiMlbMarkets(okDeps({ fetchImpl: healthyFetchImpl }));
      expect(candidates.some((c) => c.marketTicker === "KXMLBGAME-1-SD")).toBe(true);
    });

    it("malformed cursor semantics (Task 12F/P1-I) remain fail-closed and independent of the new truncation check", async () => {
      clearKalshiDiscoveryCache();
      const fetchImpl = vi.fn(async (url: string | URL) => {
        if (String(url).includes("/markets")) return new Response(JSON.stringify({ markets: [], cursor: 12345 }), { status: 200 });
        return new Response(JSON.stringify({ events: [], cursor: "" }), { status: 200 });
      }) as unknown as typeof fetch;
      await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response.*cursor/i);
    });

    it("a later-page malformed response still fails closed and is independent of the new truncation check", async () => {
      clearKalshiDiscoveryCache();
      let marketsPageCount = 0;
      const fetchImpl = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/markets")) {
          marketsPageCount += 1;
          if (marketsPageCount === 1) return new Response(JSON.stringify({ markets: [market("KXMLBGAME-1-SD")], cursor: "next-page" }), { status: 200 });
          return new Response(JSON.stringify({ markets: "not-an-array", cursor: "" }), { status: 200 });
        }
        return new Response(JSON.stringify({ events: [EVENT], cursor: "" }), { status: 200 });
      }) as unknown as typeof fetch;
      await expect(discoverKalshiMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response.*markets/i);
    });
  });
});

describe("fetchKalshiBook", () => {
  it("returns a normalized snapshot on success", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ orderbook_fp: { yes_dollars: [["0.50", "1"]], no_dollars: [] } }), { status: 200 }),
    );
    const snap = await fetchKalshiBook("t", okDeps({ fetchImpl }));
    expect(snap.venue).toBe("KALSHI");
    expect(snap.yes.bestBid).toBe(0.5);
    expect(snap.staleReason).toBeNull();
  });

  it("a fetch timeout returns an explicit failure snapshot, never throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const snap = await fetchKalshiBook("t", okDeps({ fetchImpl }));
    expect(snap.yes.bestBid).toBeNull();
    expect(snap.no.bestBid).toBeNull();
    expect(snap.staleReason).not.toBeNull();
  });

  it("a 429 returns an explicit failure snapshot and records the cooldown", async () => {
    const recordHostRateLimit = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429 }));
    const snap = await fetchKalshiBook("t", okDeps({ fetchImpl, recordHostRateLimit }));
    expect(snap.staleReason).toMatch(/429/);
    expect(recordHostRateLimit).toHaveBeenCalled();
  });

  it("CODEX P2-2 (round 2): a 429 whose cooldown recording would start AFTER the caller's deadline is STILL recorded -- an already-observed 429 fact must never be silently discarded just because the caller's own deadline has since passed", async () => {
    let now = 1_700_000_000_000;
    const deadlineAtMs = now + 100;
    const recordHostRateLimit = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => {
      now += 200; // the already-in-flight fetch itself is what crosses the deadline
      return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
    });
    const snap = await fetchKalshiBook("t", okDeps({ fetchImpl, recordHostRateLimit, now: () => now }), deadlineAtMs);
    expect(snap.staleReason).toMatch(/429/);
    expect(recordHostRateLimit).toHaveBeenCalledWith(KALSHI_HOST, 30_000);
  });

  it("a 429 that returns comfortably within the caller's deadline still records the cooldown normally -- bounded recording is preserved when time remains", async () => {
    let now = 1_700_000_000_000;
    const deadlineAtMs = now + 100_000;
    const recordHostRateLimit = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    const snap = await fetchKalshiBook("t", okDeps({ fetchImpl, recordHostRateLimit, now: () => now }), deadlineAtMs);
    expect(snap.staleReason).toMatch(/429/);
    expect(recordHostRateLimit).toHaveBeenCalledWith(KALSHI_HOST, 30_000);
  });

  it("a 5xx returns an explicit failure snapshot", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const snap = await fetchKalshiBook("t", okDeps({ fetchImpl }));
    expect(snap.staleReason).toMatch(/HTTP 500/);
  });

  it("44. repeated fetches for the same ticker never use a stale cache — always a real request", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }), { status: 200 }));
    const deps = okDeps({ fetchImpl });
    await fetchKalshiBook("t", deps);
    await fetchKalshiBook("t", deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  /** Task 12E / P1-E: same fix, same rationale, same test shape as pmus.server.test.ts's fetchPmusBook proofs. */
  it("P1-E.1: observedAt is the POST-fetch timestamp (t=4500), not the pre-fetch timestamp (t=1000), for a 3.5s successful fetch", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => {
      now = 4_500;
      return new Response(JSON.stringify({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }), { status: 200 });
    });
    const snap = await fetchKalshiBook("t", okDeps({ fetchImpl, now: () => now }));
    expect(snap.observedAt).toBe(4_500);
    expect(snap.observedAt).not.toBe(1_000);
  });

  it("P1-E.2: on a timeout/failure at t=13000, the terminal snapshot's observedAt reflects the failure time, not the request-start time", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => {
      now = 13_000;
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const snap = await fetchKalshiBook("t", okDeps({ fetchImpl, now: () => now }));
    expect(snap.staleReason).not.toBeNull();
    expect(snap.observedAt).toBe(13_000);
    expect(snap.observedAt).not.toBe(1_000);
  });

  it("P1-E.3: a 7-second slow fetch adds ~7 seconds to measured observation lateness rather than disappearing from the metric", async () => {
    const fireAtMs = 1_700_000_000_000;
    const requestedDelayMs = 0;
    let now = fireAtMs;
    const fetchImpl = vi.fn(async () => {
      now = fireAtMs + 7_000;
      return new Response(JSON.stringify({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }), { status: 200 });
    });
    const snap = await fetchKalshiBook("t", okDeps({ fetchImpl, now: () => now }));
    const patch = buildKalshiObservationPatch(snap, "YES", new Date(fireAtMs).toISOString(), requestedDelayMs);
    expect(patch.detectionLatencyMs).toBeGreaterThanOrEqual(6_990);
    expect(patch.detectionLatencyMs).toBeLessThanOrEqual(7_010);
  });
});

describe("auth/safety", () => {
  it("45. the public fetch never adds KALSHI-ACCESS-* or any other auth headers", async () => {
    clearKalshiDiscoveryCache();
    const fetchImpl = routeByPath({ "/markets": { markets: [], cursor: "" }, "/events": { events: [], cursor: "" } });
    await discoverKalshiMlbMarkets(okDeps({ fetchImpl }));
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).some((h) => /kalshi-access|signature|api-key/i.test(h))).toBe(false);
    expect(headers["Accept"]).toBe("application/json");
  });

  it("46/47. this module's actual code (imports + non-comment statements) never reaches a credential/signing/order surface", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const serverSrc = await fs.readFile(path.resolve(import.meta.dirname, "kalshi.server.ts"), "utf8");
    const pureSrc = await fs.readFile(path.resolve(import.meta.dirname, "kalshi.ts"), "utf8");

    const importLines = [...serverSrc.matchAll(/^import .*$/gm), ...pureSrc.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).not.toMatch(/credentials|signer|signing/i);
    }

    // Strip comments (both files document the forbidden literals BY NAME as proof of their
    // absence) so this checks actual code, not documentation mentioning what's absent.
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const serverCode = stripComments(serverSrc);
    const pureCode = stripComments(pureSrc);
    for (const forbidden of ["KALSHI_API_KEY_ID", "KALSHI_PRIVATE_KEY", "KALSHI-ACCESS-KEY", "KALSHI-ACCESS-SIGNATURE", "createOrder", "cancelOrder", "modifyOrder", "portfolio/balance"]) {
      expect(serverCode).not.toContain(forbidden);
      expect(pureCode).not.toContain(forbidden);
    }
  });
});

describe("Task 13E, E: the default network path (no fetchImpl override) uses the Cloudflare-Workers-safe runtimeFetch adapter, not a bare detached `fetch` reference", () => {
  function installThisSensitiveGlobalFetch(): () => void {
    const original = globalThis.fetch;
    function brandedFetch(this: unknown): ReturnType<typeof fetch> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      return Promise.resolve(new Response(JSON.stringify({ markets: [], events: [], cursor: "" }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    globalThis.fetch = brandedFetch as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("discoverKalshiMlbMarkets completes without an Illegal-invocation failure when no fetchImpl override is supplied at all", async () => {
    clearKalshiDiscoveryCache();
    const restore = installThisSensitiveGlobalFetch();
    try {
      const candidates = await discoverKalshiMlbMarkets({
        // Deliberately no `fetchImpl` here -- must fall through to the module's own
        // defaultDeps.fetchImpl, which Task 13E fixed to be runtimeFetch.
        reserveRequestSlot: async () => 0,
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        recordHostRateLimit: async () => {},
      });
      expect(candidates).toEqual([]); // the branded fetch really was called and returned successfully
    } finally {
      restore();
    }
  });

  // Task 13H: fetchKalshiBook shares pacedGetJson and defaultDeps with
  // discoverKalshiMlbMarkets above, so it is structurally guaranteed to be equally
  // receiver-safe -- but that guarantee had no dedicated proof of its own (F8). Book
  // capture is the +0/+5/+10/+30/+60 observation burst's actual per-observation network
  // call, so it deserves the identical explicit regression coverage as discovery.
  it("fetchKalshiBook completes without an Illegal-invocation failure when no fetchImpl override is supplied at all", async () => {
    const original = globalThis.fetch;
    function brandedFetch(this: unknown): ReturnType<typeof fetch> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      return Promise.resolve(new Response(JSON.stringify({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    globalThis.fetch = brandedFetch as typeof fetch;
    try {
      const snap = await fetchKalshiBook("t", {
        // Deliberately no `fetchImpl` here -- must fall through to the module's own
        // defaultDeps.fetchImpl, which Task 13E fixed to be runtimeFetch.
        reserveRequestSlot: async () => 0,
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        recordHostRateLimit: async () => {},
      });
      // A null staleReason is only reachable if the branded fetch call succeeded (this
      // === globalThis) AND the response was parsed as a genuine, non-malformed empty
      // book -- an Illegal-invocation failure would instead be caught and surfaced as a
      // non-null staleReason (fetchKalshiBook never throws, per its own doc comment).
      expect(snap.staleReason).toBeNull();
      expect(snap.yes.bestBid).toBeNull();
      expect(snap.no.bestBid).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});
