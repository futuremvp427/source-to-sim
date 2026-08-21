import { describe, expect, it, vi } from "vitest";
import type { PmusCandidate } from "./pmus";
import { resolvePmusMatch, type SourceSignal } from "./resolver";
import { fetchSourceMarketMetadata } from "./source-metadata.server";

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

describe("fetchSourceMarketMetadata", () => {
  it("maps a real gamma-api totals market into structured, ELIGIBLE SourceMarketMetadata", async () => {
    const result = await fetchSourceMarketMetadata(
      "0x98d25978a8e8afa9e318bb75ce261f161150f42f79bec8183f0800594ed58434",
      fakeFetch(GAMMA_TOTAL_FIXTURE),
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
    const result = await fetchSourceMarketMetadata("0xprop", fakeFetch(propFixture));
    expect(result.status).toBe("INELIGIBLE");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("REJECT_PROP");
  });

  it("26. fails closed with UNVERIFIED_FETCH_FAILED on a request that throws (e.g. timeout/abort)", async () => {
    const result = await fetchSourceMarketMetadata("0xtimeout", fakeThrowingFetch(new DOMException("The operation was aborted", "AbortError")));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_FETCH_FAILED");
  });

  it("26b. fails closed with UNVERIFIED_FETCH_FAILED on an HTTP error status", async () => {
    const result = await fetchSourceMarketMetadata("0xerr", fakeFetch({}, false));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_FETCH_FAILED");
  });

  it("27. fails closed with UNVERIFIED_EMPTY_RESPONSE when gamma-api returns no market for the conditionId", async () => {
    const result = await fetchSourceMarketMetadata("0xmissing", fakeFetch([]));
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_EMPTY_RESPONSE");
  });

  it("28. fails closed with UNVERIFIED_MALFORMED_RESPONSE on non-JSON response bodies", async () => {
    const result = await fetchSourceMarketMetadata("0xmalformed", fakeMalformedFetch());
    expect(result.status).toBe("UNVERIFIED");
    expect(result.betType).toBeNull();
    expect(result.reasonCode).toBe("UNVERIFIED_MALFORMED_RESPONSE");
  });

  it("28b. fails closed with UNVERIFIED_MALFORMED_RESPONSE when the response shape is not an array", async () => {
    const result = await fetchSourceMarketMetadata("0xshape", fakeFetch({ not: "an array" }));
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
    const result = await fetchSourceMarketMetadata("0xyankees-redsox", fakeFetch(fixture));
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
    const result = await fetchSourceMarketMetadata("0xalias", fakeFetch(fixture));
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
    const result = await fetchSourceMarketMetadata("0xunknown-team", fakeFetch(fixture));
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
    const result = await fetchSourceMarketMetadata("0xconflict", fakeFetch(fixture));
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
    const metadata = await fetchSourceMarketMetadata("0xintegration", fakeFetch(fixture));
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
      // Deliberately omitting the second (fetchImpl) argument entirely -- must fall
      // through to the function's own default parameter, which Task 13E fixed to be
      // runtimeFetch instead of a bare captured `fetch` reference.
      const result = await fetchSourceMarketMetadata("0xcanary");
      // The branded fetch really was called and returned successfully -- an empty
      // markets array resolves to UNVERIFIED_EMPTY_RESPONSE, never a thrown error.
      expect(result.status).toBe("UNVERIFIED");
      expect(result.reasonCode).toBe("UNVERIFIED_EMPTY_RESPONSE");
    } finally {
      restore();
    }
  });
});
