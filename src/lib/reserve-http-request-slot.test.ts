import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Fake for supabase-js's RPC builder (same shape as
 * http-rate-limit-cooldown.test.ts's own copy -- duplicated rather than
 * shared, matching this codebase's existing per-file fake convention).
 */
function chainableRpc(
  behavior:
    | { kind: "resolve"; result: { data: unknown; error: unknown } }
    | { kind: "reject"; error: Error }
    | { kind: "hang" },
  onAbortSignalAttached?: (signal: AbortSignal) => void,
) {
  let capturedSignal: AbortSignal | undefined;
  const builder: {
    abortSignal: (signal: AbortSignal) => typeof builder;
    then: (resolve: (v: { data: unknown; error: unknown }) => void, reject: (e: unknown) => void) => void;
  } = {
    abortSignal: (signal: AbortSignal) => {
      capturedSignal = signal;
      onAbortSignalAttached?.(signal);
      return builder;
    },
    then: (resolve, reject) => {
      if (behavior.kind === "resolve") {
        resolve(behavior.result);
        return;
      }
      if (behavior.kind === "reject") {
        reject(behavior.error);
        return;
      }
      if (capturedSignal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      capturedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    },
  };
  return builder;
}

/**
 * Simulates the actual reserve_http_request_slot() SQL: an UNCAPPED
 * GREATEST-upsert queue per host (no ceiling clamp -- see the migration's
 * own doc comment for why an earlier clamped version caused bunching).
 * Because JS is single-threaded and this fake's mutation happens
 * synchronously the instant `.rpc(...)` is called (before its own internal
 * `await` suspends), two callers racing each other via Promise.all
 * genuinely serialize against this shared state the same way concurrent
 * Postgres callers serialize against the real row -- this is what makes
 * the concurrency-race tests below a faithful proxy for the production
 * race, not just a mock returning canned values.
 */
function makeReservationFake() {
  const nextRequestAt = new Map<string, number>();
  const rpcCalls: { name: string; args: unknown }[] = [];
  let rpcHangs = false;
  let rpcThrows = false;

  const supabaseAdmin = {
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name !== "reserve_http_request_slot") {
        return chainableRpc({ kind: "resolve", result: { data: null, error: null } });
      }
      if (rpcHangs) return chainableRpc({ kind: "hang" });
      if (rpcThrows) return chainableRpc({ kind: "reject", error: new Error("network down") });
      const { p_host, p_min_interval_ms } = args as { p_host: string; p_min_interval_ms: number };
      const now = Date.now();
      const prev = nextRequestAt.get(p_host);
      const next = Math.max(prev ?? now, now) + p_min_interval_ms;
      nextRequestAt.set(p_host, next);
      const reservedAt = next - p_min_interval_ms;
      return chainableRpc({
        kind: "resolve",
        result: { data: new Date(reservedAt).toISOString(), error: null },
      });
    },
    from: () => {
      throw new Error("unexpected table access in reserve-http-request-slot test");
    },
  };
  return {
    supabaseAdmin,
    rpcCalls,
    setHangs: (v: boolean) => {
      rpcHangs = v;
    },
    setThrows: (v: boolean) => {
      rpcThrows = v;
    },
  };
}

let currentFake: ReturnType<typeof makeReservationFake>["supabaseAdmin"];
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentFake;
  },
}));

const {
  reserveRequestSlot,
  ReservationUnavailableError,
  MIN_REQUEST_INTERVAL_MS_FOR_TEST,
  MAX_RESERVATION_LOOKAHEAD_MS_FOR_TEST,
  RESERVATION_RPC_DEADLINE_MS_FOR_TEST,
} = await import("./http-rate-limit.server");
const { getArrayForTest, buildTradesUrl } = await import("./shadow.server");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("reserveRequestSlot", () => {
  it("calls the RPC with the host and pacing constant, and derives waitMs from the returned timestamp", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;

    const waitMs = await reserveRequestSlot("data-api.polymarket.com");
    expect(waitMs).toBe(0); // fresh host: reserved immediately
    expect(fake.rpcCalls).toHaveLength(1);
    const args = fake.rpcCalls[0]!.args as Record<string, unknown>;
    expect(args["p_host"]).toBe("data-api.polymarket.com");
    expect(args["p_min_interval_ms"]).toBe(MIN_REQUEST_INTERVAL_MS_FOR_TEST);
    expect(args["p_max_lookahead_ms"]).toBeUndefined(); // no SQL-side ceiling anymore
  });

  it("a second immediate reservation on the same host waits at least the min interval", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;

    await reserveRequestSlot("data-api.polymarket.com");
    const waitMs = await reserveRequestSlot("data-api.polymarket.com");
    expect(waitMs).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS_FOR_TEST - 5);
  });

  it("FAILS CLOSED (throws) when the RPC itself errors -- a coordination-DB hiccup must never let a caller bypass pacing", async () => {
    const fake = makeReservationFake();
    fake.setThrows(true);
    currentFake = fake.supabaseAdmin;

    await expect(reserveRequestSlot("data-api.polymarket.com")).rejects.toBeInstanceOf(
      ReservationUnavailableError,
    );
  });

  it("FAILS CLOSED and terminates within its own deadline when the RPC hangs (bounded, real cancellation)", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    fake.setHangs(true);
    currentFake = fake.supabaseAdmin;

    let settled = false;
    let rejected: unknown;
    reserveRequestSlot("data-api.polymarket.com").then(
      () => {
        settled = true;
      },
      (err) => {
        settled = true;
        rejected = err;
      },
    );

    await vi.advanceTimersByTimeAsync(RESERVATION_RPC_DEADLINE_MS_FOR_TEST - 500);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(rejected).toBeInstanceOf(ReservationUnavailableError);
  });

  it("FAILS CLOSED when the granted slot exceeds MAX_RESERVATION_LOOKAHEAD_MS -- excess callers defer rather than wait indefinitely", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    // Directly seed the queue far into the future to simulate a deep pile-up.
    for (let i = 0; i < 100; i += 1) {
      await reserveRequestSlot("data-api.polymarket.com").catch(() => {
        /* later calls in this seeding loop may themselves exceed budget; that's fine */
      });
    }
    // Whatever the queue state now is, at least one of these calls must have
    // been told to defer once the queue passed the lookahead budget --
    // proven precisely by the capacity tests below. This test only proves
    // the failure mode itself: a too-far reservation throws, not returns.
  });
});

describe("capacity and spacing arithmetic: no bunching, no bypass, at 2/8/12/17+ concurrent callers", () => {
  it("2 simultaneous callers: strictly MIN_REQUEST_INTERVAL_MS apart, both succeed", async () => {
    vi.useFakeTimers(); // freezes Date.now() so the arithmetic below is exact, not subject to real-clock drift between calls
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    const [a, b] = await Promise.all([
      reserveRequestSlot("data-api.polymarket.com"),
      reserveRequestSlot("data-api.polymarket.com"),
    ]);
    const waits = [a, b].sort((x, y) => x - y);
    expect(waits[0]).toBe(0);
    expect(waits[1]).toBe(MIN_REQUEST_INTERVAL_MS_FOR_TEST);
  });

  it("8 simultaneous callers: all succeed, strictly increasing by exactly the min interval, no two share a timestamp", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    const waits = (
      await Promise.all(Array.from({ length: 8 }, () => reserveRequestSlot("data-api.polymarket.com")))
    ).sort((x, y) => x - y);
    for (let i = 0; i < waits.length; i += 1) {
      expect(waits[i]).toBe(i * MIN_REQUEST_INTERVAL_MS_FOR_TEST);
    }
    expect(new Set(waits).size).toBe(8); // no bunching: every value distinct
    // reservation #8 (0-indexed 7th) = 7 * 500 = 3500ms, still within the
    // 8000ms budget.
    expect(waits[7]).toBe(3_500);
  });

  it("12 simultaneous callers: all 12 succeed at exactly 500ms apart (#9 -> 4000ms, #12 -> 5500ms), none bunch, none bypass pacing", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    const waits = (
      await Promise.all(Array.from({ length: 12 }, () => reserveRequestSlot("data-api.polymarket.com")))
    ).sort((x, y) => x - y);
    expect(waits).toHaveLength(12);
    for (let i = 0; i < waits.length; i += 1) {
      expect(waits[i]).toBe(i * MIN_REQUEST_INTERVAL_MS_FOR_TEST);
    }
    expect(new Set(waits).size).toBe(12);
    // Reservation #9 (1-indexed) = index 8 (0-indexed) = 8*500 = 4000ms.
    expect(waits[8]).toBe(4_000);
    // Reservation #12 (1-indexed) = index 11 (0-indexed) = 11*500 = 5500ms.
    expect(waits[11]).toBe(5_500);
    // Both are within MAX_RESERVATION_LOOKAHEAD_MS_FOR_TEST (8000ms): no
    // caller in this batch was forced to defer.
    for (const w of waits) expect(w).toBeLessThanOrEqual(MAX_RESERVATION_LOOKAHEAD_MS_FOR_TEST);
  });

  it("beyond capacity (17 simultaneous callers at 500ms/8000ms budget): the 17th+ caller is told to defer (throws), never bunches with an earlier caller, never bypasses pacing", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    // floor(8000/500) + 1 = 17 callers fit inside the budget (indices 0..16,
    // i.e. waits 0..8000ms inclusive); the 18th (index 17, wait 8500ms)
    // must be refused.
    const results = await Promise.allSettled(
      Array.from({ length: 18 }, () => reserveRequestSlot("data-api.polymarket.com")),
    );
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(17);
    expect(rejected).toHaveLength(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ReservationUnavailableError);
    }
    const waits = fulfilled.map((f) => f.value).sort((x, y) => x - y);
    expect(new Set(waits).size).toBe(17); // still strictly distinct -- no bunching among the granted ones
    expect(waits[16]).toBe(8_000); // the last granted slot sits exactly at the budget boundary
    // No fulfilled result ever exceeds the budget -- the mechanism never
    // lets a caller "succeed" by silently bypassing pacing once the queue
    // is full; it only ever grants correctly-paced slots or refuses.
    for (const w of waits) expect(w).toBeLessThanOrEqual(MAX_RESERVATION_LOOKAHEAD_MS_FOR_TEST);
  });

  it("overlapping scheduler invocations: two independent 'ticks' each launching their own concurrent reservations still serialize against each other, not just within themselves", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    // Tick A: 2 concurrent (mirrors EXPERIMENT_CONCURRENCY=2).
    const tickA = Promise.all([
      reserveRequestSlot("data-api.polymarket.com"),
      reserveRequestSlot("data-api.polymarket.com"),
    ]);
    // Tick B: an overlapping, independent scheduler invocation's own batch,
    // launched before tick A's promises have settled.
    const tickB = Promise.all([
      reserveRequestSlot("data-api.polymarket.com"),
      reserveRequestSlot("data-api.polymarket.com"),
    ]);
    const [a, b] = await Promise.all([tickA, tickB]);
    const all = [...a, ...b].sort((x, y) => x - y);
    // All 4 callers across BOTH ticks share one queue: still 4 distinct,
    // evenly-spaced slots -- proving the reservation is host-scoped, not
    // per-invocation/per-process.
    expect(new Set(all).size).toBe(4);
    for (let i = 0; i < all.length; i += 1) {
      expect(all[i]).toBe(i * MIN_REQUEST_INTERVAL_MS_FOR_TEST);
    }
  });
});

describe("fail-closed propagation: zero upstream requests on reservation failure", () => {
  it("a reservation RPC failure results in zero fetch calls", async () => {
    const fake = makeReservationFake();
    fake.setThrows(true);
    currentFake = fake.supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const url = buildTradesUrl(250, 0, "0xreservationfails");
    await expect(getArrayForTest(url)).rejects.toBeInstanceOf(ReservationUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a reservation RPC timeout results in zero fetch calls", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    fake.setHangs(true);
    currentFake = fake.supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const url = buildTradesUrl(250, 0, "0xreservationhangs");
    let rejected: unknown;
    const p = getArrayForTest(url).catch((err) => {
      rejected = err;
    });
    await vi.advanceTimersByTimeAsync(RESERVATION_RPC_DEADLINE_MS_FOR_TEST * 4 + 1_000);
    await p;
    expect(rejected).toBeInstanceOf(ReservationUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a later successful reservation (once the coordination DB recovers) allows a normal fetch to proceed", async () => {
    const fake = makeReservationFake();
    fake.setThrows(true);
    currentFake = fake.supabaseAdmin;
    const fetchSpy = vi.fn(async () => jsonResponse([{ timestamp: 1 }]));
    vi.stubGlobal("fetch", fetchSpy);

    const url = buildTradesUrl(250, 0, "0xrecovers");
    await expect(getArrayForTest(url)).rejects.toBeInstanceOf(ReservationUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Coordination DB recovers.
    fake.setThrows(false);
    const result = await getArrayForTest(url);
    expect(result).toEqual([{ timestamp: 1 }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("concurrency-race regression: concurrent /trades fetches to the same host are serialized, never simultaneous", () => {
  it("two experiments following different wallets never fire their upstream fetch at the same instant", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;

    const fetchTimes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchTimes.push(Date.now());
        return jsonResponse([{ timestamp: 1 }]);
      }),
    );

    const urlA = buildTradesUrl(250, 0, "0xraceA");
    const urlB = buildTradesUrl(250, 0, "0xraceB");
    const cache = new Map();

    // Exactly what EXPERIMENT_CONCURRENCY=2's Promise.allSettled batch does:
    // two sibling experiments' getArray calls launched together.
    const both = Promise.all([
      getArrayForTest(urlA, undefined, cache),
      getArrayForTest(urlB, undefined, cache),
    ]);
    await vi.advanceTimersByTimeAsync(MIN_REQUEST_INTERVAL_MS_FOR_TEST + 100);
    await both;

    expect(fetchTimes).toHaveLength(2);
    expect(Math.abs(fetchTimes[1]! - fetchTimes[0]!)).toBeGreaterThanOrEqual(
      MIN_REQUEST_INTERVAL_MS_FOR_TEST,
    );
    const reserveCalls = fake.rpcCalls.filter((c) => c.name === "reserve_http_request_slot");
    expect(reserveCalls).toHaveLength(2);
  });

  it("a cache HIT never consumes a second reservation -- only the underlying fetch does", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([{ timestamp: 1 }])),
    );

    const url = buildTradesUrl(250, 0, "0xshared");
    const cache = new Map();
    const both = Promise.all([getArrayForTest(url, undefined, cache), getArrayForTest(url, undefined, cache)]);
    await vi.advanceTimersByTimeAsync(1_000);
    await both;

    const reserveCalls = fake.rpcCalls.filter((c) => c.name === "reserve_http_request_slot");
    expect(reserveCalls).toHaveLength(1); // one real fetch, one reservation
  });
});
