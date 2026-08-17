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
 * Simulates the actual reserve_http_request_slot() SQL: a GREATEST-upsert
 * queue per host, clamped by max_lookahead. Because JS is single-threaded
 * and this fake's mutation happens synchronously the instant `.rpc(...)` is
 * called (before its own internal `await` suspends), two callers racing
 * each other via Promise.all genuinely serialize against this shared state
 * the same way concurrent Postgres callers serialize against the real
 * row -- this is what makes the concurrency-race test below a faithful
 * proxy for the production race, not just a mock returning canned values.
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
      const { p_host, p_min_interval_ms, p_max_lookahead_ms } = args as {
        p_host: string;
        p_min_interval_ms: number;
        p_max_lookahead_ms: number;
      };
      const now = Date.now();
      const prev = nextRequestAt.get(p_host);
      const ceiling = now + p_max_lookahead_ms + p_min_interval_ms;
      const next = Math.min(Math.max(prev ?? now, now) + p_min_interval_ms, ceiling);
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
  it("calls the RPC with the host and pacing constants, and derives waitMs from the returned timestamp", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;

    const waitMs = await reserveRequestSlot("data-api.polymarket.com");
    expect(waitMs).toBe(0); // fresh host: reserved immediately
    expect(fake.rpcCalls).toHaveLength(1);
    const args = fake.rpcCalls[0]!.args as Record<string, unknown>;
    expect(args["p_host"]).toBe("data-api.polymarket.com");
    expect(args["p_min_interval_ms"]).toBe(MIN_REQUEST_INTERVAL_MS_FOR_TEST);
    expect(args["p_max_lookahead_ms"]).toBe(MAX_RESERVATION_LOOKAHEAD_MS_FOR_TEST);
  });

  it("a second immediate reservation on the same host waits at least the min interval", async () => {
    const fake = makeReservationFake();
    currentFake = fake.supabaseAdmin;

    await reserveRequestSlot("data-api.polymarket.com");
    const waitMs = await reserveRequestSlot("data-api.polymarket.com");
    expect(waitMs).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS_FOR_TEST - 5);
  });

  it("fails OPEN (waitMs 0) when the RPC itself errors -- pacing is best-effort, blocked_until remains the real safety net", async () => {
    const fake = makeReservationFake();
    fake.setThrows(true);
    currentFake = fake.supabaseAdmin;

    await expect(reserveRequestSlot("data-api.polymarket.com")).resolves.toBe(0);
  });

  it("fails OPEN and terminates within its own deadline when the RPC hangs (bounded, real cancellation)", async () => {
    vi.useFakeTimers();
    const fake = makeReservationFake();
    fake.setHangs(true);
    currentFake = fake.supabaseAdmin;

    let resolved: number | undefined;
    reserveRequestSlot("data-api.polymarket.com").then((v) => {
      resolved = v;
    });

    await vi.advanceTimersByTimeAsync(RESERVATION_RPC_DEADLINE_MS_FOR_TEST - 500);
    expect(resolved).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolved).toBe(0);
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
    // The reservation RPC was consulted once per real request -- one per URL.
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
