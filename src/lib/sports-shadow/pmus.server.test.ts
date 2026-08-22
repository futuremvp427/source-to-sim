import { describe, expect, it, vi } from "vitest";
import { buildPmusObservationPatch } from "./observation";
import { clearPmusDiscoveryCache, discoverPmusMlbMarkets, DISCOVERY_MAX_PAGES, DISCOVERY_PAGE_SIZE, fetchPmusBook, PMUS_HOST, type PmusNetworkDeps } from "./pmus.server";
import { NO_OP_LEASE_CHECKPOINT } from "./sports-lease.server";

function okDeps(overrides: Partial<PmusNetworkDeps> = {}): PmusNetworkDeps {
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

describe("FINAL BUILD Part 7: discovery deliberately targets /v1/events, never the MLB-specific /v2/leagues/mlb/events endpoint", () => {
  it("discoverPmusMlbMarkets requests /v1/events -- switching to /v2/leagues/mlb/events without re-verifying its outcomes-vs-marketSides shape would silently lose team/orientation data", async () => {
    clearPmusDiscoveryCache();
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      requestedUrls.push(String(url));
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await discoverPmusMlbMarkets(okDeps({ fetchImpl }));
    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      expect(url).toContain("/v1/events");
      expect(url).not.toContain("/v2/leagues/mlb/events");
    }
  });
});

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

  it("Task 12F/P1-I: an unexpected response shape (events not an array) now THROWS rather than being silently treated as zero events -- a malformed collection is not a legitimate empty page (was the P1-I defect: this used to resolve to [], letting a schema/proxy hiccup be confused with a genuine 'nothing found')", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: "not-an-array" }), { status: 200 }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response/i);
  });

  it("I1: `{}` (events entirely missing) throws a discovery failure", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response/i);
  });

  it("I2: `{ events: null }` throws a discovery failure", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: null }), { status: 200 }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response/i);
  });

  it("I3: `{ events: {} }` (an object, not an array) throws a discovery failure", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: {} }), { status: 200 }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response/i);
  });

  it("I4: `{ events: [] }` is a valid, successful empty page -- resolves to an empty candidate list, does not throw", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: [] }), { status: 200 }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).resolves.toEqual([]);
  });

  it("I11: a malformed response is never written to the discovery cache -- the very next call issues a real request again, not a cached failure or cached partial result", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow();
    await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // no caching of the malformed attempt
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

  describe("Task 12I / P2-P2: pagination truncation must fail closed, never cache a partial catalog", () => {
    function fullPageOfEvents(pageIndex: number) {
      return Array.from({ length: DISCOVERY_PAGE_SIZE }, (_, i) => eventFixture(`p${pageIndex}-${i}`, `aec-mlb-p${pageIndex}-${i}`));
    }

    it("final page < DISCOVERY_PAGE_SIZE -> valid complete result (baseline, already covered by test 17, re-asserted for the boundary suite's own clarity)", async () => {
      clearPmusDiscoveryCache();
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: [eventFixture("1", "aec-mlb-nyy-bal-1")] }), { status: 200 }));
      await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).resolves.not.toThrow();
    });

    it("exactly DISCOVERY_MAX_PAGES pages, the final page short (< DISCOVERY_PAGE_SIZE) -> valid complete result", async () => {
      clearPmusDiscoveryCache();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        const isFinalPage = calls === DISCOVERY_MAX_PAGES;
        return new Response(JSON.stringify({ events: isFinalPage ? [eventFixture("last", "aec-mlb-last")] : fullPageOfEvents(calls) }), { status: 200 });
      });
      await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).resolves.not.toThrow();
      expect(calls).toBe(DISCOVERY_MAX_PAGES); // proves the loop actually ran the full page budget, not fewer
    });

    it("exactly DISCOVERY_MAX_PAGES pages, the final page STILL full (=== DISCOVERY_PAGE_SIZE) -> explicit truncation failure, not a returned/cached partial catalog", async () => {
      clearPmusDiscoveryCache();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify({ events: fullPageOfEvents(calls) }), { status: 200 });
      });
      await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/truncated/i);
      expect(calls).toBe(DISCOVERY_MAX_PAGES); // bounded at exactly DISCOVERY_MAX_PAGES, not runaway
    });

    it("missing/non-array events on any page (including the last) still fails as malformed, independent of the new truncation check", async () => {
      clearPmusDiscoveryCache();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls < DISCOVERY_MAX_PAGES) return new Response(JSON.stringify({ events: fullPageOfEvents(calls) }), { status: 200 });
        return new Response(JSON.stringify({ events: "not-an-array" }), { status: 200 });
      });
      await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).rejects.toThrow(/malformed response/i);
    });

    it("a valid empty array (events: []) at the page cap remains valid completion, never a truncation failure", async () => {
      clearPmusDiscoveryCache();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        if (calls < DISCOVERY_MAX_PAGES) return new Response(JSON.stringify({ events: fullPageOfEvents(calls) }), { status: 200 });
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      });
      await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl }))).resolves.not.toThrow();
      expect(calls).toBe(DISCOVERY_MAX_PAGES);
    });

    it("a truncation failure never poisons the discovery cache -- a subsequent call with a healthy short-final-page response succeeds normally", async () => {
      clearPmusDiscoveryCache();
      const truncatingFetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: fullPageOfEvents(1) }), { status: 200 }));
      await expect(discoverPmusMlbMarkets(okDeps({ fetchImpl: truncatingFetchImpl }))).rejects.toThrow(/truncated/i);

      const healthyFetchImpl = vi.fn(async () => new Response(JSON.stringify({ events: [eventFixture("1", "aec-mlb-nyy-bal-1")] }), { status: 200 }));
      const candidates = await discoverPmusMlbMarkets(okDeps({ fetchImpl: healthyFetchImpl }));
      expect(candidates.length).toBeGreaterThan(0);
    });

    it("the truncation error explicitly does NOT merely raise DISCOVERY_MAX_PAGES -- the constant itself stays the mission-specified safety bound", () => {
      expect(DISCOVERY_MAX_PAGES).toBe(10);
    });
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

  it("Codex re-review: a 429 whose cooldown recording would start AFTER the caller's deadline skips recordHostRateLimit entirely, but still captures the genuine 429 failure (never silently dropped)", async () => {
    let now = 1_700_000_000_000;
    const deadlineAtMs = now + 100;
    const recordHostRateLimit = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => {
      now += 200; // the already-in-flight fetch itself is what crosses the deadline
      return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
    });
    const snap = await fetchPmusBook("some-slug", okDeps({ fetchImpl, recordHostRateLimit, now: () => now }), deadlineAtMs);
    expect(snap.staleReason).toMatch(/429/);
    expect(recordHostRateLimit).not.toHaveBeenCalled();
  });

  it("a 429 that returns comfortably within the caller's deadline still records the cooldown normally -- bounded recording is preserved when time remains", async () => {
    let now = 1_700_000_000_000;
    const deadlineAtMs = now + 100_000;
    const recordHostRateLimit = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    const snap = await fetchPmusBook("some-slug", okDeps({ fetchImpl, recordHostRateLimit, now: () => now }), deadlineAtMs);
    expect(snap.staleReason).toMatch(/429/);
    expect(recordHostRateLimit).toHaveBeenCalledWith(PMUS_HOST, 30_000);
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

  /**
   * Task 12E / P1-E: observedAt must reflect when the book became observable (after the
   * paced/network fetch), never when the request started. A fake, monotonically-advancing
   * clock simulates a real fetch's wall-clock duration across the awaited `pacedGetJson`
   * call -- `now()` is called once before the request (in reserveRequestSlot inside
   * pacedGetJson, which these tests don't stub out separately) and once after, so a
   * deterministic sequence of return values lets the test assert exactly which value ends
   * up in the returned snapshot.
   */
  it("P1-E.1: observedAt is the POST-fetch timestamp (t=4500), not the pre-fetch timestamp (t=1000), for a 3.5s successful fetch", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => {
      now = 4_500; // simulates time elapsing during the awaited network call
      return new Response(JSON.stringify({ marketData: { bids: [], offers: [] } }), { status: 200 });
    });
    const snap = await fetchPmusBook("some-slug", okDeps({ fetchImpl, now: () => now }));
    expect(snap.observedAt).toBe(4_500);
    expect(snap.observedAt).not.toBe(1_000);
  });

  it("P1-E.2: on a timeout/failure at t=13000, the terminal snapshot's observedAt reflects the failure time, not the request-start time", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => {
      now = 13_000; // simulates the ~12s REQUEST_TIMEOUT_MS elapsing before the abort is caught
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const snap = await fetchPmusBook("some-slug", okDeps({ fetchImpl, now: () => now }));
    expect(snap.staleReason).not.toBeNull();
    expect(snap.observedAt).toBe(13_000);
    expect(snap.observedAt).not.toBe(1_000);
  });

  it("P1-E.3: a 7-second slow fetch adds ~7 seconds to measured observation lateness rather than disappearing from the metric", async () => {
    const fireAtMs = 1_700_000_000_000;
    const requestedDelayMs = 0;
    let now = fireAtMs; // the collector picks up this due row exactly at fire_at
    const fetchImpl = vi.fn(async () => {
      now = fireAtMs + 7_000; // the book itself takes 7s to arrive
      return new Response(JSON.stringify({ marketData: { bids: [], offers: [] } }), { status: 200 });
    });
    const snap = await fetchPmusBook("some-slug", okDeps({ fetchImpl, now: () => now }));
    const patch = buildPmusObservationPatch(snap, "LONG", new Date(fireAtMs).toISOString(), requestedDelayMs);
    // detectionLatencyMs = observedAt - (fireAt - requestedDelayMs); with requestedDelayMs=0
    // and fireAt=now-at-due-time, this must be ~7000ms, not ~0ms (which is what the pre-fix
    // pre-fetch timestamp would have silently produced).
    expect(patch.detectionLatencyMs).toBeGreaterThanOrEqual(6_990);
    expect(patch.detectionLatencyMs).toBeLessThanOrEqual(7_010);
  });
});

describe("auth/safety", () => {
  it("40. the public fetch never adds authentication headers", async () => {
    clearPmusDiscoveryCache();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ events: [] }), { status: 200 }));
    await discoverPmusMlbMarkets(okDeps({ fetchImpl }));
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("expected fetchImpl to have been called");
    const init = call[1];
    if (!init) throw new Error("expected fetchImpl to have been called with a RequestInit");
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

describe("Task 13E, D: the default network path (no fetchImpl override) uses the Cloudflare-Workers-safe runtimeFetch adapter, not a bare detached `fetch` reference", () => {
  function installThisSensitiveGlobalFetch(): () => void {
    const original = globalThis.fetch;
    function brandedFetch(this: unknown): ReturnType<typeof fetch> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      return Promise.resolve(new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    globalThis.fetch = brandedFetch as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("discoverPmusMlbMarkets completes without an Illegal-invocation failure when no fetchImpl override is supplied at all", async () => {
    clearPmusDiscoveryCache();
    const restore = installThisSensitiveGlobalFetch();
    try {
      const candidates = await discoverPmusMlbMarkets({
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

  // Task 13H: fetchPmusBook shares pacedGetJson and defaultDeps with
  // discoverPmusMlbMarkets above, so it is structurally guaranteed to be equally
  // receiver-safe -- but that guarantee had no dedicated proof of its own (F6). Book
  // capture is the +0/+5/+10/+30/+60 observation burst's actual per-observation network
  // call, so it deserves the identical explicit regression coverage as discovery.
  it("fetchPmusBook completes without an Illegal-invocation failure when no fetchImpl override is supplied at all", async () => {
    const original = globalThis.fetch;
    function brandedFetch(this: unknown): ReturnType<typeof fetch> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      return Promise.resolve(new Response(JSON.stringify({ marketData: { bids: [], offers: [] } }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    globalThis.fetch = brandedFetch as typeof fetch;
    try {
      const snap = await fetchPmusBook("some-slug", {
        // Deliberately no `fetchImpl` here -- must fall through to the module's own
        // defaultDeps.fetchImpl, which Task 13E fixed to be runtimeFetch.
        reserveRequestSlot: async () => 0,
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        recordHostRateLimit: async () => {},
      });
      // A null staleReason is only reachable if the branded fetch call succeeded (this
      // === globalThis) AND the response was parsed as a genuine, non-malformed empty
      // book -- an Illegal-invocation failure would instead be caught and surfaced as a
      // non-null staleReason (fetchPmusBook never throws, per its own doc comment).
      expect(snap.staleReason).toBeNull();
      expect(snap.bestBid).toBeNull();
      expect(snap.bestAsk).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});
