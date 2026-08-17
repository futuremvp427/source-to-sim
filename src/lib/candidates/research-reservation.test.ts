import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Proves candidate research's OWN independent HTTP layer (getJson in this
 * file, NOT shadow.server.ts's getJson) is gated by the same atomic
 * data-api.polymarket.com pacing reservation ingestion uses. This module
 * has its own fetcher because it predates the shared one and talks to
 * THREE hosts (data-api, gamma-api, clob) -- only data-api shares
 * Polymarket's host-wide rate limit that this whole mechanism exists to
 * pace, so only /trades and /positions (fetchPublicTrades/
 * fetchPublicPositions) should ever claim a reservation; /public-search
 * (resolveHandle, gamma-api) and /prices-history (fetchSlippageSamples,
 * clob) must not.
 */

function chainableRpc(result: { data: unknown; error: unknown }) {
  const builder: {
    abortSignal: (signal: AbortSignal) => typeof builder;
    then: (resolve: (v: typeof result) => void) => void;
  } = {
    abortSignal: () => builder,
    then: (resolve) => resolve(result),
  };
  return builder;
}

/** Same uncapped GREATEST-queue simulation as reserve-http-request-slot.test.ts. */
function makeReservationFake() {
  const nextRequestAt = new Map<string, number>();
  const rpcCalls: { name: string; args: unknown }[] = [];
  let throws = false;

  const supabaseAdmin = {
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name !== "reserve_http_request_slot") {
        return chainableRpc({ data: null, error: null });
      }
      if (throws) return chainableRpc({ data: null, error: { message: "reservation unavailable" } });
      const { p_host, p_min_interval_ms } = args as { p_host: string; p_min_interval_ms: number };
      const now = Date.now();
      const prev = nextRequestAt.get(p_host);
      const next = Math.max(prev ?? now, now) + p_min_interval_ms;
      nextRequestAt.set(p_host, next);
      return chainableRpc({ data: new Date(next - p_min_interval_ms).toISOString(), error: null });
    },
  };
  return { supabaseAdmin, rpcCalls, setThrows: (v: boolean) => (throws = v) };
}

let currentFake: ReturnType<typeof makeReservationFake>["supabaseAdmin"];
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentFake;
  },
}));

const { getJson, fetchPublicTrades, fetchPublicPositions, fetchSlippageSamples, resolveHandle } =
  await import("./research.server");
const { ReservationUnavailableError, MIN_REQUEST_INTERVAL_MS_FOR_TEST } = await import(
  "../http-rate-limit.server"
);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("candidate research reservation gating: only data-api.polymarket.com is paced", () => {
  it("fetchPublicTrades (data-api /trades) claims a reservation before fetching", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));

    await fetchPublicTrades("0xcandidate");

    const reserveCalls = fake.rpcCalls.filter((c) => c.name === "reserve_http_request_slot");
    expect(reserveCalls.length).toBeGreaterThanOrEqual(1);
    expect((reserveCalls[0]!.args as { p_host: string }).p_host).toBe("data-api.polymarket.com");
  });

  it("fetchPublicPositions (data-api /positions) claims a reservation before fetching", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));

    await fetchPublicPositions("0xcandidate");

    const reserveCalls = fake.rpcCalls.filter((c) => c.name === "reserve_http_request_slot");
    expect(reserveCalls).toHaveLength(1);
    expect((reserveCalls[0]!.args as { p_host: string }).p_host).toBe("data-api.polymarket.com");
  });

  it("resolveHandle (gamma-api /public-search) does NOT claim a reservation -- a separate host with no evidence it shares data-api's limit", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ profiles: [] })));

    await resolveHandle("somehandle");

    expect(fake.rpcCalls.filter((c) => c.name === "reserve_http_request_slot")).toHaveLength(0);
  });

  it("fetchSlippageSamples (clob.polymarket.com /prices-history) does NOT claim a reservation", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ history: [] })));

    const trades = [{ asset: "a1", size: 1, price: 0.5, ts: 1000, title: "t", slug: "s", outcome: "Yes", side: "BUY" as const }];
    await fetchSlippageSamples(trades);

    expect(fake.rpcCalls.filter((c) => c.name === "reserve_http_request_slot")).toHaveLength(0);
  });

  it("a plain getJson call to a data-api URL reserves; the identical URL shape against gamma-api/clob does not", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));

    await getJson("https://data-api.polymarket.com/trades?user=0xabc");
    await getJson("https://gamma-api.polymarket.com/public-search?q=abc");
    await getJson("https://clob.polymarket.com/prices-history?market=abc");

    expect(fake.rpcCalls.filter((c) => c.name === "reserve_http_request_slot")).toHaveLength(1);
  });
});

describe("candidate research reservation pacing: concurrent /trades + /positions calls serialize against the SAME host budget", () => {
  it("fetchPublicTrades and fetchPublicPositions racing each other are paced at least MIN_REQUEST_INTERVAL_MS apart -- the limiter is host-scoped, not URL-scoped", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    const fetchTimes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchTimes.push(Date.now());
        return jsonResponse([]);
      }),
    );

    const both = Promise.all([fetchPublicTrades("0xa"), fetchPublicPositions("0xa")]);
    await vi.advanceTimersByTimeAsync(MIN_REQUEST_INTERVAL_MS_FOR_TEST + 100);
    await both;

    expect(fetchTimes).toHaveLength(2);
    expect(Math.abs(fetchTimes[1]! - fetchTimes[0]!)).toBeGreaterThanOrEqual(
      MIN_REQUEST_INTERVAL_MS_FOR_TEST,
    );
  });
});

describe("candidate research fail-closed: a reservation failure is retried like any other transient failure, never fires an ungated fetch", () => {
  it("a persistently failing reservation exhausts getJson's own attempts, with zero fetch calls, and throws (not a silent empty result)", async () => {
    const fake = makeReservationFake();
    fake.setThrows(true);
    currentFake = fake.supabaseAdmin;
    const fetchSpy = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchPublicTrades("0xfails")).rejects.toBeInstanceOf(ReservationUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a reservation failure that recovers mid-retry still succeeds -- reservation shares getJson's existing attempts/backoff, it doesn't bypass it", async () => {
    const fake = makeReservationFake();
    fake.setThrows(true);
    currentFake = fake.supabaseAdmin;
    const fetchSpy = vi.fn(async () => jsonResponse([{ timestamp: 1, side: "BUY", asset: "a" }]));
    vi.stubGlobal("fetch", fetchSpy);

    const promise = fetchPublicTrades("0xrecovers");
    // Flip to success before getJson's 2nd (final) attempt fires -- the
    // 400ms fixed retry delay between attempts gives real time for this.
    setTimeout(() => fake.setThrows(false), 50);
    const result = await promise;

    expect(result).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the successful attempt ever reaches fetch
  });
});

describe("candidate research deadline semantics: an abort during the reservation wait is a run-level abort, not a fake unresolved candidate", () => {
  it("an already-aborted signal short-circuits getJson before any reservation or fetch call, throwing ResearchBudgetExhaustedError", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new AbortController();
    controller.abort();

    await expect(fetchPublicTrades("0xaborted", controller.signal)).rejects.toThrow(
      /research deadline reached/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.rpcCalls.filter((c) => c.name === "reserve_http_request_slot")).toHaveLength(0);
  });

  it("a signal that aborts during the reservation wait still surfaces as a research-deadline abort, not a plain fetch failure", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    // A realistic fetch stub: honors an already-aborted signal by
    // rejecting (real fetch() does this too), unlike a stub that always
    // resolves regardless of the signal it was handed.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return jsonResponse([]);
      }),
    );

    // Pre-seed the queue so the NEXT reservation must wait a real interval,
    // giving the abort below a window to land mid-wait.
    await fetchPublicTrades("0xseed");

    const controller = new AbortController();
    let rejected: unknown;
    // Attaches the rejection handler immediately, before advancing fake
    // timers -- attaching it only after (e.g. via a bare `await
    // expect(promise).rejects...` on the next line) races Node's
    // unhandledRejection detection against when the promise actually
    // settles during the timer flush below.
    fetchPublicTrades("0xabortedmidwait", controller.signal).catch((err) => {
      rejected = err;
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/research deadline reached/);
  });
});
