import { describe, expect, it, vi } from "vitest";
import { DeadlineExceededError } from "../http-rate-limit.server";
import type { PmusCandidate } from "./pmus";
import { resolvePmusMatch, type SourceSignal } from "./resolver";
import { GAMMA_HOST, fetchSourceMarketMetadata, type GammaNetworkDeps } from "./source-metadata.server";

const GAMMA_TOTAL_FIXTURE = [
  {
    conditionId: "0x98d25978a8e8afa9e318bb75ce261f161150f42f79bec8183f0800594ed58434",
    slug: "mlb-wsh-tex-2026-08-19-total-7pt5",
    question: "Washington Nationals vs. Texas Rangers: O/U 7.5",
    groupItemTitle: "O/U 7.5",
    sportsMarketType: "totals",
    line: 7.5,
    gameStartTime: "2026-08-20 00:05:00+00",
    events: [
      {
        gameId: 10079198,
        slug: "mlb-wsh-tex-2026-08-19",
        sport: { sport: "mlb" },
        teams: [
          { name: "Washington Nationals", abbreviation: "wsh", ordering: "away" },
          { name: "Texas Rangers", abbreviation: "tex", ordering: "home" },
        ],
      },
    ],
  },
];

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? status : 500 })) as unknown as typeof fetch;
}

function fakeMalformedFetch(): typeof fetch {
  return vi.fn(async () => new Response("not json {{{", { status: 200 })) as unknown as typeof fetch;
}

function fakeThrowingFetch(err: unknown): typeof fetch {
  return vi.fn(async () => {
    throw err;
  }) as unknown as typeof fetch;
}

/**
 * CODEX P2-2: fetchSourceMarketMetadata now routes through the shared host-aware rate
 * limiter -- every test in this file must inject a no-op cooldown/reservation so it never
 * reaches the real Supabase-backed http-rate-limit.server.ts functions.
 */
function fakeGammaDeps(fetchImpl: typeof fetch): GammaNetworkDeps {
  return {
    fetchImpl,
    reserveRequestSlot: async () => 0,
    getHostCooldown: async () => ({ blocked: false, reason: null }),
    recordHostRateLimit: async () => {},
    now: () => Date.now(),
  };
}

describe("fetchSourceMarketMetadata", () => {
  it("maps a real gamma-api totals market into structured, ELIGIBLE SourceMarketMetadata", async () => {
    const result = await fetchSourceMarketMetadata(
      "0x98d25978a8e8afa9e318bb75ce261f161150f42f79bec8183f0800594ed58434",
      fakeGammaDeps(fakeFetch(GAMMA_TOTAL_FIXTURE)),
    );
    expect(result).toEqual({
      conditionId: "0x98d25978a8e8afa9e318bb75ce261f161150f42f79bec8183f0800594ed58434",
      league: "mlb",
      sportsMarketType: "totals",
      betType: "TOTAL",
      status: "ELIGIBLE",
      reasonCode: "ELIGIBLE_FULL_GAME_TOTAL",
      ineligibleReason: null,
      line: 7.5,
      awayTeam: "WSH",
      homeTeam: "TEX",
      gameStartTime: "2026-08-20 00:05:00+00",
      sourceGameId: "10079198",
      eventSlug: "mlb-wsh-tex-2026-08-19",
      marketSlug: "mlb-wsh-tex-2026-08-19-total-7pt5",
      sourceRulesDescription: null, // GAMMA_TOTAL_FIXTURE does not set a `description` field
    });
  });

  it("returns an INELIGIBLE result rather than throwing for a prop market", async () => {
    const propFixture = [
      {
        ...GAMMA_TOTAL_FIXTURE[0],
        conditionId: "0xprop",
        sportsMarketType: "player_prop",
        question: "Mike Trout: Home Runs O/U 0.5",
      },
    ];
    const result = await fetchSourceMarketMetadata("0xprop", fakeGammaDeps(fakeFetch(propFixture)));
    expect(result.status).toBe("INELIGIBLE");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("REJECT_PROP");
  });

  it("26. fails closed with UNVERIFIED_FETCH_FAILED on a request that throws (e.g. timeout/abort)", async () => {
    const result = await fetchSourceMarketMetadata("0xtimeout", fakeGammaDeps(fakeThrowingFetch(new DOMException("The operation was aborted", "AbortError"))));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_FETCH_FAILED");
  });

  it("26b. fails closed with UNVERIFIED_FETCH_FAILED on an HTTP error status", async () => {
    const result = await fetchSourceMarketMetadata("0xerr", fakeGammaDeps(fakeFetch({}, false)));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_FETCH_FAILED");
  });

  it("27. fails closed with UNVERIFIED_EMPTY_RESPONSE when gamma-api returns no market for the conditionId", async () => {
    const result = await fetchSourceMarketMetadata("0xmissing", fakeGammaDeps(fakeFetch([])));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_EMPTY_RESPONSE");
  });

  it("28. fails closed with UNVERIFIED_MALFORMED_RESPONSE on non-JSON response bodies", async () => {
    const result = await fetchSourceMarketMetadata("0xmalformed", fakeGammaDeps(fakeMalformedFetch()));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_MALFORMED_RESPONSE");
  });

  it("28b. fails closed with UNVERIFIED_MALFORMED_RESPONSE when the response shape is not an array", async () => {
    const result = await fetchSourceMarketMetadata("0xshape", fakeGammaDeps(fakeFetch({ not: "an array" })));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_MALFORMED_RESPONSE");
  });

  /* ------------------------------------------------------------------ */
  /* Task 12E / P1-D: canonical source team identity                     */
  /* ------------------------------------------------------------------ */

  it("P1-D.1: persists the classifier's canonical MLB codes, not the raw Gamma display names (New York Yankees/Boston Red Sox -> NYY/BOS)", async () => {
    const fixture = [
      {
        ...GAMMA_TOTAL_FIXTURE[0],
        conditionId: "0xyankees-redsox",
        slug: "mlb-nyy-bos-2026-08-19",
        sportsMarketType: "moneyline",
        line: null,
        events: [
          {
            gameId: 1,
            slug: "mlb-nyy-bos-2026-08-19",
            sport: { sport: "mlb" },
            teams: [
              { name: "New York Yankees", ordering: "away" },
              { name: "Boston Red Sox", ordering: "home" },
            ],
          },
        ],
      },
    ];
    const result = await fetchSourceMarketMetadata("0xyankees-redsox", fakeGammaDeps(fakeFetch(fixture)));
    expect(result.status).toBe("ELIGIBLE");
    expect(result.awayTeam).toBe("NYY");
    expect(result.homeTeam).toBe("BOS");
  });

  it("P1-D.2: valid team aliases normalize to the same canonical code as the full franchise name", async () => {
    const fixture = [
      {
        ...GAMMA_TOTAL_FIXTURE[0],
        conditionId: "0xalias",
        slug: "mlb-nyy-bos-2026-08-19",
        sportsMarketType: "moneyline",
        line: null,
        events: [
          {
            gameId: 1,
            slug: "mlb-nyy-bos-2026-08-19",
            sport: { sport: "mlb" },
            // "Yankees" / "Red Sox" are aliases, not the full franchise names.
            teams: [
              { name: "Yankees", ordering: "away" },
              { name: "Red Sox", ordering: "home" },
            ],
          },
        ],
      },
    ];
    const result = await fetchSourceMarketMetadata("0xalias", fakeGammaDeps(fakeFetch(fixture)));
    expect(result.status).toBe("ELIGIBLE");
    expect(result.awayTeam).toBe("NYY");
    expect(result.homeTeam).toBe("BOS");
  });

  it("P1-D.3: an unrecognized team name remains UNVERIFIED with null awayTeam/homeTeam -- never fabricated into a canonical code", async () => {
    const fixture = [
      {
        ...GAMMA_TOTAL_FIXTURE[0],
        conditionId: "0xunknown-team",
        slug: "mlb-xyz-bos-2026-08-19",
        sportsMarketType: "moneyline",
        line: null,
        events: [
          {
            gameId: 1,
            slug: "mlb-xyz-bos-2026-08-19",
            sport: { sport: "mlb" },
            teams: [
              { name: "Some Minor League Team", ordering: "away" },
              { name: "Boston Red Sox", ordering: "home" },
            ],
          },
        ],
      },
    ];
    const result = await fetchSourceMarketMetadata("0xunknown-team", fakeGammaDeps(fakeFetch(fixture)));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.reasonCode).toBe("UNVERIFIED_UNKNOWN_TEAM");
    expect(result.awayTeam).toBeNull();
    expect(result.homeTeam).toBeNull();
  });

  it("P1-D.4: a structured-vs-slug team conflict remains UNVERIFIED with null awayTeam/homeTeam", async () => {
    const fixture = [
      {
        ...GAMMA_TOTAL_FIXTURE[0],
        conditionId: "0xconflict",
        slug: "mlb-lad-sf-2026-08-19", // slug says LAD@SF
        sportsMarketType: "moneyline",
        line: null,
        events: [
          {
            gameId: 1,
            slug: "mlb-lad-sf-2026-08-19",
            sport: { sport: "mlb" },
            teams: [
              // structured says NYY@BAL -- conflicts with the slug
              { name: "New York Yankees", ordering: "away" },
              { name: "Baltimore Orioles", ordering: "home" },
            ],
          },
        ],
      },
    ];
    const result = await fetchSourceMarketMetadata("0xconflict", fakeGammaDeps(fakeFetch(fixture)));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.reasonCode).toBe("UNVERIFIED_CONFLICTING_METADATA");
    expect(result.awayTeam).toBeNull();
    expect(result.homeTeam).toBeNull();
  });

  it("P1-D.5 (source -> resolver integration): a real fetchSourceMarketMetadata result's canonical teams successfully EXACT-match a PM-US candidate, rather than NONE_NO_CANDIDATE from a full-name-vs-code mismatch", async () => {
    const fixture = [
      {
        ...GAMMA_TOTAL_FIXTURE[0],
        conditionId: "0xintegration",
        slug: "mlb-nyy-bal-2026-08-19",
        sportsMarketType: "moneyline",
        // CODEX P1-6: EXACT now requires the SOURCE's own rules text to positively agree
        // with the target's -- this test is about team-code matching (P1-D), not P1-6's
        // settlement-rule dimension, so give it real agreeing text rather than leaving it
        // unset and accidentally downgrading to UNVERIFIED on an unrelated dimension.
        description: "This market will resolve to the winner of the game. Extra innings are included. If the game is postponed, this market will remain open until completed.",
        line: null,
        events: [
          {
            gameId: 1,
            slug: "mlb-nyy-bal-2026-08-19",
            sport: { sport: "mlb" },
            teams: [
              { name: "New York Yankees", ordering: "away" },
              { name: "Baltimore Orioles", ordering: "home" },
            ],
          },
        ],
      },
    ];
    const metadata = await fetchSourceMarketMetadata("0xintegration", fakeGammaDeps(fakeFetch(fixture)));
    expect(metadata.status).toBe("ELIGIBLE");
    expect(metadata.betType).toBe("MONEYLINE");

    // Exactly the fields Task 11's worker.ts's toSourceSignal maps 1:1 from a persisted
    // sports_shadow_signals row into resolver.ts's SourceSignal (see worker.ts).
    const sourceSignal: SourceSignal = {
      betType: metadata.betType!,
      awayTeam: metadata.awayTeam ?? "",
      homeTeam: metadata.homeTeam ?? "",
      gameStartTime: metadata.gameStartTime,
      line: metadata.line,
      selectedOutcomeRaw: "New York Yankees",
      conditionId: metadata.conditionId,
      sourceGameId: metadata.sourceGameId,
      eventSlug: metadata.eventSlug,
      marketSlug: metadata.marketSlug,
      sourceRulesDescription: metadata.sourceRulesDescription,
    };

    const pmusCandidate: PmusCandidate = {
      status: "ELIGIBLE",
      reasonCode: "ELIGIBLE_FULL_GAME_MONEYLINE",
      betType: "MONEYLINE",
      eventId: "ev-1",
      eventSlug: "mlb-nyy-bal-2026-08-19",
      gameId: "1",
      marketId: "mkt-1",
      marketSlug: "aec-mlb-nyy-bal-2026-08-19",
      // Task 12G/P1-K: must exactly match the source's gameStartTime ("2026-08-20
      // 00:05:00+00" from GAMMA_TOTAL_FIXTURE, parsed as 2026-08-20T00:05:00Z) --
      // groupByGame now requires exact-timestamp proof even for a same-team singleton.
      scheduledStartAt: "2026-08-20T00:05:00Z",
      league: "mlb",
      // The PM-US/Kalshi discovery pipelines have always used canonical codes here (see
      // pmus.ts/kalshi.ts's own classifiers) -- P1-D was that the SOURCE side alone used
      // raw display names, breaking the strict-equality match in resolver.ts's
      // groupByGame.
      awayTeam: "NYY",
      homeTeam: "BAL",
      line: null,
      active: true,
      closed: false,
      marketStatus: "MARKET_STATUS_OPEN",
      question: "New York Yankees vs. Baltimore Orioles",
      rulesDescription:
        "This market will settle to the winner of the game. Extra innings are included if played. If the game is delayed, postponed, or suspended and not rescheduled within two weeks, the market will settle to the last fair market price.",
      sides: [
        { description: "New York Yankees", teamAbbreviation: "nyy", long: true },
        { description: "Baltimore Orioles", teamAbbreviation: "bal", long: false },
      ],
    };

    const result = resolvePmusMatch(sourceSignal, [pmusCandidate]);
    expect(result.status).toBe("EXACT");
    expect(result.reasonCode).not.toBe("NONE_NO_CANDIDATE");
  });
});

describe("Task 13E, F: the default fetch path (no fetchImpl argument) uses the Cloudflare-Workers-safe runtimeFetch adapter, not a bare detached `fetch` reference", () => {
  function installThisSensitiveGlobalFetch(): () => void {
    const original = globalThis.fetch;
    function brandedFetch(this: unknown): ReturnType<typeof fetch> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }));
    }
    globalThis.fetch = brandedFetch as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("fetchSourceMarketMetadata completes without an Illegal-invocation failure when no fetchImpl argument is supplied at all", async () => {
    const restore = installThisSensitiveGlobalFetch();
    try {
      // Deliberately omitting `fetchImpl` from deps -- must fall through to
      // GammaNetworkDeps's own default, which Task 13E fixed to be runtimeFetch instead of
      // a bare captured `fetch` reference. The rate-limiter deps ARE overridden (CODEX
      // P2-2 added them) so this test never reaches the real Supabase-backed
      // http-rate-limit.server.ts functions -- unrelated to what this test verifies.
      const result = await fetchSourceMarketMetadata("0xcanary", {
        reserveRequestSlot: async () => 0,
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        recordHostRateLimit: async () => {},
      });
      // The branded fetch really was called and returned successfully -- an empty
      // markets array resolves to UNVERIFIED_EMPTY_RESPONSE, never a thrown error.
      expect(result.status).toBe("UNVERIFIED");
      expect(result.reasonCode).toBe("UNVERIFIED_EMPTY_RESPONSE");
    } finally {
      restore();
    }
  });
});

describe("CODEX P2-2: Gamma metadata now routes through the shared host-aware rate limiter", () => {
  it("a cooldown-blocked host resolves to UNVERIFIED_FETCH_FAILED (retryable -- classifyUnverifiedDisposition never converts this to permanent) WITHOUT ever attempting the request", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchSourceMarketMetadata("0xcooldown", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getHostCooldown: async () => ({ blocked: true, reason: "recent 429" }),
    });
    expect(result.status).toBe("UNVERIFIED");
    expect(result.reasonCode).toBe("UNVERIFIED_FETCH_FAILED");
    expect(result.ineligibleReason).toMatch(/cooldown/i);
    expect(fetchImpl).not.toHaveBeenCalled(); // never even attempted the request
  });

  it("a genuine 429 records the cooldown via recordHostRateLimit and resolves to UNVERIFIED_FETCH_FAILED -- subsequent same-host work must respect the recorded cooldown rather than continuing to hammer Gamma", async () => {
    const recordHostRateLimit = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;
    const first = await fetchSourceMarketMetadata("0xratelimited", {
      fetchImpl,
      getHostCooldown: async () => ({ blocked: false, reason: null }),
      reserveRequestSlot: async () => 0,
      recordHostRateLimit,
    });
    expect(first.reasonCode).toBe("UNVERIFIED_FETCH_FAILED");
    expect(recordHostRateLimit).toHaveBeenCalledWith(GAMMA_HOST, 30_000);

    // A SECOND lookup, using a repo/cooldown store that now reflects that recorded
    // cooldown, must be blocked before ever attempting another request -- this is the
    // actual "does not continue to hammer Gamma" property, proven end-to-end rather than
    // merely asserting the first call's side effect in isolation.
    const secondFetch = vi.fn();
    const second = await fetchSourceMarketMetadata("0xratelimited-2", {
      fetchImpl: secondFetch as unknown as typeof fetch,
      getHostCooldown: async () => ({ blocked: true, reason: "429 retry-after" }),
    });
    expect(second.reasonCode).toBe("UNVERIFIED_FETCH_FAILED");
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("reserveRequestSlot's own granted wait is honored (paced, not fired immediately)", async () => {
    const waitedMs: number[] = [];
    const originalSetTimeout = global.setTimeout;
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms !== undefined && ms > 0 && ms < 5_000) waitedMs.push(ms); // the pacing sleep specifically, not the 10s request-timeout timer
      return originalSetTimeout(fn, 0);
    }) as unknown as typeof setTimeout);
    try {
      const result = await fetchSourceMarketMetadata("0xpaced", {
        fetchImpl: fakeFetch([]) as unknown as typeof fetch,
        getHostCooldown: async () => ({ blocked: false, reason: null }),
        reserveRequestSlot: async () => 250,
      });
      expect(waitedMs).toContain(250);
      expect(result.status).toBe("UNVERIFIED"); // request still completed after pacing
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a caller deadline already reached before the cooldown check throws DeadlineExceededError, not an UNVERIFIED result -- a scheduler-budget exhaustion is never persisted as evidence about the market", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchSourceMarketMetadata(
        "0xdeadline",
        { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000 },
        500, // deadline already in the past relative to now()
      ),
    ).rejects.toThrow(DeadlineExceededError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
