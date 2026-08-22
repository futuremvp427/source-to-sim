import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal chainable fake for the subset of the PostgREST query builder this
 * module actually calls: .select()/.update()/.eq() all return the same
 * chainable object, and the object itself is a thenable so `await
 * builder.eq().eq()` resolves without a separate terminal method call —
 * mirroring how supabase-js's real builder works.
 */
function chainable(result: { data: unknown; error: unknown }) {
  const builder: {
    select: () => typeof builder;
    update: (patch: unknown) => typeof builder;
    eq: () => typeof builder;
    abortSignal: () => typeof builder;
    maybeSingle: () => Promise<typeof result>;
    then: (resolve: (v: typeof result) => void) => void;
  } = {
    select: () => builder,
    update: () => builder,
    eq: () => builder,
    abortSignal: () => builder,
    maybeSingle: async () => result,
    then: (resolve) => resolve(result),
  };
  return builder;
}

type CooldownRow = { blocked_until: string; reason: string } | null;

/**
 * A chainable whose terminal await never settles on its own -- simulates a stalled query.
 * Task 13I: getHostCooldown now attaches a real AbortSignal via .abortSignal() before the
 * terminal .maybeSingle() call, so this fake must react to that signal exactly like
 * chainableRpc's "hang" behavior does -- proving REAL cancellation, not mere abandonment.
 */
function hangingChainable() {
  let capturedSignal: AbortSignal | undefined;
  const builder: {
    select: () => typeof builder;
    eq: () => typeof builder;
    abortSignal: (signal: AbortSignal) => typeof builder;
    maybeSingle: () => Promise<never>;
  } = {
    select: () => builder,
    eq: () => builder,
    abortSignal: (signal: AbortSignal) => {
      capturedSignal = signal;
      return builder;
    },
    maybeSingle: () =>
      new Promise<never>((_resolve, reject) => {
        if (capturedSignal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        capturedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
  };
  return builder;
}

/**
 * Fake for supabase-js's RPC builder, which is a thenable that also exposes
 * .abortSignal(signal) -- real postgrest-js ties that signal to the
 * underlying fetch, so an abort actually rejects the in-flight request
 * rather than merely being ignored. `behavior` selects between resolving
 * normally, rejecting immediately (simulating a network error), or hanging
 * until the attached AbortSignal fires (simulating a stalled request that
 * only real cancellation -- not Promise.race abandonment -- can terminate).
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
    then: (
      resolve: (v: { data: unknown; error: unknown }) => void,
      reject: (e: unknown) => void,
    ) => void;
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
      // hang: only settles if/when the attached signal aborts -- this is
      // what proves real cancellation (vs. Promise.race abandonment, which
      // would never touch this promise at all and leave it hanging forever).
      if (capturedSignal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      capturedSignal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    },
  };
  return builder;
}

/** A chainable that supports .eq() chaining but whose await never settles. */
function hangingUpdateChainable() {
  const builder: { eq: () => typeof builder; then: () => void } = {
    eq: () => builder,
    then: () => {
      /* never resolves or rejects -- simulates a stalled worker_status update */
    },
  };
  return builder;
}

function makeFakeSupabase(opts: {
  cooldownRow: CooldownRow | "error" | "hang";
  leaseFence?: number | null;
  rpcHangs?: boolean;
  rpcThrows?: boolean;
  onRecordRpcAbortSignal?: (signal: AbortSignal) => void;
  workerStatusUpdateHangs?: boolean;
  /** Reservation-specific failure injection, independent of rpcHangs/rpcThrows above (those only affect record_http_rate_limit). */
  reservationHangs?: boolean;
  reservationThrows?: boolean;
  onReservationAbortSignal?: (signal: AbortSignal) => void;
  /** Task 13I: controls the granted reservation's offset from "now" -- lets a test construct a specific non-zero wait to exercise the caller-deadline-vs-granted-wait comparison. Defaults to 0 (immediate), matching prior behavior. */
  reservationGrantedInMs?: number;
}) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const fromCalls: string[] = [];
  const updateCalls: { table: string; patch: unknown }[] = [];

  const supabaseAdmin = {
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      // Grants an immediate reservation by default so every test in this
      // file that isn't specifically about reservation behavior can reach
      // an actual fetch() exactly as it did before reserveRequestSlot
      // existed -- only reservationHangs/reservationThrows opt into
      // exercising the fail-CLOSED path.
      if (name === "reserve_http_request_slot") {
        if (opts.reservationHangs) return chainableRpc({ kind: "hang" }, opts.onReservationAbortSignal);
        if (opts.reservationThrows) {
          return chainableRpc({ kind: "reject", error: new Error("reservation network down") });
        }
        return chainableRpc({
          kind: "resolve",
          result: { data: new Date(Date.now() + (opts.reservationGrantedInMs ?? 0)).toISOString(), error: null },
        });
      }
      if (opts.rpcHangs && name === "record_http_rate_limit") {
        return chainableRpc({ kind: "hang" }, opts.onRecordRpcAbortSignal);
      }
      if (opts.rpcThrows && name === "record_http_rate_limit") {
        return chainableRpc({ kind: "reject", error: new Error("network down") });
      }
      if (name === "acquire_worker_lease") {
        return chainableRpc({
          kind: "resolve",
          result: { data: opts.leaseFence === undefined ? 1 : opts.leaseFence, error: null },
        });
      }
      return chainableRpc({ kind: "resolve", result: { data: null, error: null } });
    },
    from: (table: string) => {
      fromCalls.push(table);
      if (table === "http_rate_limits") {
        if (opts.cooldownRow === "hang") return hangingChainable();
        return chainable(
          opts.cooldownRow === "error"
            ? { data: null, error: { message: "connection reset" } }
            : { data: opts.cooldownRow, error: null },
        );
      }
      if (table === "worker_status") {
        return {
          update: (patch: unknown) => {
            updateCalls.push({ table, patch });
            return opts.workerStatusUpdateHangs
              ? hangingUpdateChainable()
              : chainable({ data: null, error: null });
          },
          select: () => chainable({ data: null, error: null }),
        };
      }
      // Fresh-worker checkpoint read/write: only reachable when the
      // cooldown check above did NOT block -- i.e. the reservation tests
      // below, which deliberately let the cycle proceed this far (either
      // failing inside the fetch pipeline before any paper accounting
      // table is touched, or -- once reservations succeed -- all the way
      // through to a real checkpoint upsert). Any OTHER table would still
      // hit the throw below, since this fake only ever supports this one
      // additional table beyond http_rate_limits/worker_status.
      if (table === "worker_checkpoints") {
        return {
          select: () => chainable({ data: null, error: null }),
          eq: () => chainable({ data: null, error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
          upsert: async () => ({ data: null, error: null }),
        };
      }
      // Any other table means the cooldown gate failed to short-circuit
      // before touching checkpoints/accounting -- fail loudly rather than
      // silently returning empty data.
      throw new Error(
        `FakeSupabase: unexpected table access during a cooldown-gated cycle: ${table}`,
      );
    },
  };
  return { supabaseAdmin, rpcCalls, fromCalls, updateCalls };
}

let currentFake: ReturnType<typeof makeFakeSupabase>["supabaseAdmin"];

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentFake;
  },
}));

const {
  clampCooldownMs,
  getHostCooldown,
  recordHostRateLimit,
  reserveRequestSlot,
  DeadlineExceededError,
  ReservationUnavailableError,
  DATA_API_HOST,
  MIN_COOLDOWN_MS_FOR_TEST,
  DEFAULT_COOLDOWN_MS_FOR_TEST,
  MAX_COOLDOWN_MS_FOR_TEST,
  COOLDOWN_WRITE_DEADLINE_MS_FOR_TEST,
  RESERVATION_RPC_DEADLINE_MS_FOR_TEST,
  MAX_RESERVATION_LOOKAHEAD_MS_FOR_TEST,
} = await import("./http-rate-limit.server");
const {
  runExperimentCycle,
  getJsonForTest,
  buildTradesUrl,
  HOST_COOLDOWN_CHECK_DEADLINE_MS_FOR_TEST,
  CLEANUP_RELEASE_DEADLINE_MS_FOR_TEST,
  candidateResearchIfCycleAndHostAllowForTest,
  RateLimitedError,
} = await import("./shadow.server");
const { ingestGeneralActivity } = await import("./general-shadow.server");
const { probePublicDataApiForTest, resetPublicApiProbeCacheForTest } =
  await import("./health.server");

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function baseExperiment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "exp-1",
    name: "SHADOW V2: Poligarch",
    wallet_address: "0xb40e89677d59665d5188541ad860450a6e2a7cc9",
    starting_cash: 380,
    cash: 380,
    buy_amount: 5,
    poll_interval_seconds: 60,
    enabled: true,
    weather_only: false,
    realized_pnl: 0,
    follow_from_ts: 1_700_000_000,
    ...overrides,
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clampCooldownMs", () => {
  it("uses the default when no candidate is given", () => {
    expect(clampCooldownMs(null)).toBe(DEFAULT_COOLDOWN_MS_FOR_TEST);
  });

  it("floors a too-short candidate at MIN_COOLDOWN_MS", () => {
    expect(clampCooldownMs(1_000)).toBe(MIN_COOLDOWN_MS_FOR_TEST);
  });

  it("ceils a pathologically long candidate at MAX_COOLDOWN_MS", () => {
    expect(clampCooldownMs(60 * 60 * 1000)).toBe(MAX_COOLDOWN_MS_FOR_TEST);
  });

  it("passes through an in-range candidate unchanged", () => {
    expect(clampCooldownMs(120_000)).toBe(120_000);
  });
});

describe("getHostCooldown", () => {
  it("reports not blocked when no cooldown row exists", async () => {
    currentFake = makeFakeSupabase({ cooldownRow: null }).supabaseAdmin;
    const result = await getHostCooldown(DATA_API_HOST);
    expect(result.blocked).toBe(false);
  });

  it("reports not blocked once blocked_until is in the past", async () => {
    currentFake = makeFakeSupabase({
      cooldownRow: { blocked_until: new Date(Date.now() - 1000).toISOString(), reason: "expired" },
    }).supabaseAdmin;
    const result = await getHostCooldown(DATA_API_HOST);
    expect(result.blocked).toBe(false);
  });

  it("reports blocked while blocked_until is in the future", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    currentFake = makeFakeSupabase({
      cooldownRow: { blocked_until: until, reason: "429 without Retry-After" },
    }).supabaseAdmin;
    const result = await getHostCooldown(DATA_API_HOST);
    expect(result.blocked).toBe(true);
    expect(result.until?.toISOString()).toBe(until);
    expect(result.reason).toBe("429 without Retry-After");
  });

  it("fails CLOSED (treats as blocked) when the read itself errors", async () => {
    currentFake = makeFakeSupabase({ cooldownRow: "error" }).supabaseAdmin;
    const result = await getHostCooldown(DATA_API_HOST);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/unreadable/);
  });
});

describe("recordHostRateLimit", () => {
  it("calls the record_http_rate_limit RPC with a clamped, extended blocked_until", async () => {
    const { supabaseAdmin, rpcCalls } = makeFakeSupabase({ cooldownRow: null });
    currentFake = supabaseAdmin;
    const before = Date.now();
    await recordHostRateLimit(DATA_API_HOST, 5_000); // below MIN_COOLDOWN_MS, must be floored
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.name).toBe("record_http_rate_limit");
    const args = rpcCalls[0]!.args as { p_host: string; p_blocked_until: string };
    expect(args.p_host).toBe(DATA_API_HOST);
    const untilMs = new Date(args.p_blocked_until).getTime();
    expect(untilMs).toBeGreaterThanOrEqual(before + MIN_COOLDOWN_MS_FOR_TEST);
  });

  it("never throws even if the RPC itself fails (best-effort write)", async () => {
    currentFake = makeFakeSupabase({ cooldownRow: null, rpcThrows: true }).supabaseAdmin;
    await expect(recordHostRateLimit(DATA_API_HOST, null)).resolves.toBeUndefined();
  });
});

describe("429 gets zero in-process retries (no upstream amplification)", () => {
  it("a single 429 fails immediately without any retry attempt", async () => {
    let calls = 0;
    currentFake = makeFakeSupabase({ cooldownRow: null }).supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({}, 429);
      }),
    );

    const url = buildTradesUrl(250, 0, "0xabc");
    await expect(getJsonForTest(url, 3)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("a non-429 transient failure still retries up to the bounded attempt count", async () => {
    let calls = 0;
    currentFake = makeFakeSupabase({ cooldownRow: null }).supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({}, 500);
      }),
    );

    const url = buildTradesUrl(250, 0, "0xabc");
    await expect(getJsonForTest(url, 3)).rejects.toThrow();
    expect(calls).toBe(3);
  });
});

describe("runExperimentCycle respects an active host cooldown", () => {
  it("defers before touching any checkpoint/accounting table, and releases the lease as idle (not error)", async () => {
    const until = new Date(Date.now() + 90_000).toISOString();
    const { supabaseAdmin, updateCalls, rpcCalls } = makeFakeSupabase({
      cooldownRow: { blocked_until: until, reason: "429 without Retry-After" },
    });
    currentFake = supabaseAdmin;

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runExperimentCycle(baseExperiment(), "test-worker");

    expect(result.skipped).toMatch(/rate-limit cooldown active/);
    expect(fetchSpy).not.toHaveBeenCalled(); // no upstream call at all
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.table).toBe("worker_status");
    expect((updateCalls[0]!.patch as { state: string }).state).toBe("idle");
    expect((updateCalls[0]!.patch as { last_error?: unknown }).last_error).toBeUndefined();
    // A cycle deferred at the cycle-start cooldown check must never reach
    // getJson, so it must never consume a pacing reservation either.
    expect(rpcCalls.some((c) => c.name === "reserve_http_request_slot")).toBe(false);
  });

  it("suppresses upstream calls across repeated scheduler invocations while the cooldown remains active", async () => {
    const until = new Date(Date.now() + 90_000).toISOString();
    currentFake = makeFakeSupabase({
      cooldownRow: { blocked_until: until, reason: "429 without Retry-After" },
    }).supabaseAdmin;

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // Two independent "ticks" -- fresh runExperimentCycle calls, exactly as
    // two separate scheduler invocations would look.
    const first = await runExperimentCycle(baseExperiment(), "tick-1");
    const second = await runExperimentCycle(baseExperiment(), "tick-2");

    expect(first.skipped).toMatch(/cooldown active/);
    expect(second.skipped).toMatch(/cooldown active/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed (defers) when the cooldown state itself cannot be read", async () => {
    const { supabaseAdmin, updateCalls } = makeFakeSupabase({ cooldownRow: "error" });
    currentFake = supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runExperimentCycle(baseExperiment(), "test-worker");

    expect(result.skipped).toMatch(/cooldown active/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updateCalls[0]).toBeDefined();
    expect((updateCalls[0]!.patch as { state: string }).state).toBe("idle");
  });
});

describe("General Shadow respects the same host cooldown", () => {
  it("getActivityPage does not retry on 429 and records the shared host cooldown", async () => {
    let calls = 0;
    const { supabaseAdmin, rpcCalls } = makeFakeSupabase({ cooldownRow: null });
    currentFake = supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({}, 429, { "retry-after": "45" });
      }),
    );

    // ingestGeneralActivity catches the per-page error internally and marks
    // the result truncated rather than throwing -- that is its documented
    // contract (a failed page never discards pages already fetched).
    const outcome = await ingestGeneralActivity("0xgeneralshadow");
    expect(outcome.truncated).toBe(true);
    // Exactly one fetch call: no in-process retry on 429.
    expect(calls).toBe(1);
    // And the shared host cooldown was recorded so /trades callers back off too.
    expect(rpcCalls.some((c) => c.name === "record_http_rate_limit")).toBe(true);
  });
});

describe("the cooldown read itself is bounded (cannot strand the lease)", () => {
  it("fails closed and still releases the lease as idle when the cooldown read hangs", async () => {
    vi.useFakeTimers();
    const { supabaseAdmin, updateCalls } = makeFakeSupabase({ cooldownRow: "hang" });
    currentFake = supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const promise = runExperimentCycle(baseExperiment(), "test-worker");
    let result: Awaited<ReturnType<typeof runExperimentCycle>> | undefined;
    promise.then((r) => {
      result = r;
    });

    // Nothing should have resolved yet -- the read is still hanging.
    await vi.advanceTimersByTimeAsync(HOST_COOLDOWN_CHECK_DEADLINE_MS_FOR_TEST - 500);
    expect(result).toBeUndefined();

    // Past its own bound, the call must resolve -- not hang for the life of
    // the process the way the pre-Phase-1 checkpoint-load hang did.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result).toBeDefined();
    expect(result!.skipped).toMatch(/cooldown active/);
    expect(fetchSpy).not.toHaveBeenCalled();
    // And the lease was actually released (idle), not left held.
    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0]!.patch as { state: string }).state).toBe("idle");
  });
});

describe("the cooldown write is bounded by real cancellation, safely awaited by both 429 paths", () => {
  it("A: on a normal 429, the cooldown write actually completes (RPC observed) before /trades' own promise settles", async () => {
    const { supabaseAdmin, rpcCalls } = makeFakeSupabase({ cooldownRow: null });
    currentFake = supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 429)),
    );

    const url = buildTradesUrl(250, 0, "0xwritecompletes");
    await expect(getJsonForTest(url, 3)).rejects.toBeInstanceOf(RateLimitedError);

    // The write is awaited (not fire-and-forget), so by the time the
    // rejection is observed here, the RPC has already been issued.
    expect(rpcCalls.some((c) => c.name === "record_http_rate_limit")).toBe(true);
  });

  it("B: a permanently stalled cooldown RPC is actually cancelled at COOLDOWN_WRITE_DEADLINE_MS, and the /trades path still terminates", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    currentFake = makeFakeSupabase({
      cooldownRow: null,
      rpcHangs: true,
      onRecordRpcAbortSignal: (signal) => {
        capturedSignal = signal;
      },
    }).supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 429)),
    );

    const url = buildTradesUrl(250, 0, "0xwritestalled");
    let settled = false;
    let rejected: unknown;
    getJsonForTest(url, 3).then(
      () => {
        settled = true;
      },
      (err) => {
        settled = true;
        rejected = err;
      },
    );

    // Still waiting on the bounded write just short of its own deadline.
    await vi.advanceTimersByTimeAsync(COOLDOWN_WRITE_DEADLINE_MS_FOR_TEST - 500);
    expect(settled).toBe(false);

    // Past the write's own deadline, the whole call must terminate.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(rejected).toBeInstanceOf(RateLimitedError);
    // Real cancellation, not mere abandonment: the signal handed to the RPC
    // builder actually transitioned to aborted.
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("C: the same stalled-RPC scenario for General Shadow's /activity path -- ingestGeneralActivity still terminates, with real cancellation", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    currentFake = makeFakeSupabase({
      cooldownRow: null,
      rpcHangs: true,
      onRecordRpcAbortSignal: (signal) => {
        capturedSignal = signal;
      },
    }).supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 429, { "retry-after": "45" })),
    );

    let settled = false;
    let outcome: Awaited<ReturnType<typeof ingestGeneralActivity>> | undefined;
    ingestGeneralActivity("0xgeneralshadowstalled").then((r) => {
      settled = true;
      outcome = r;
    });

    await vi.advanceTimersByTimeAsync(COOLDOWN_WRITE_DEADLINE_MS_FOR_TEST - 500);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(outcome?.truncated).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("D: no dangling/unbounded DB operation remains -- fake timers have nothing left pending once both paths above settle", async () => {
    vi.useFakeTimers();
    currentFake = makeFakeSupabase({ cooldownRow: null, rpcHangs: true }).supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 429)),
    );

    const url = buildTradesUrl(250, 0, "0xnodangling");
    const promise = getJsonForTest(url, 3).catch(() => {
      /* expected */
    });

    await vi.advanceTimersByTimeAsync(COOLDOWN_WRITE_DEADLINE_MS_FOR_TEST + 1_000);
    await promise;

    // The only way this call settles at all is via the deadline's own
    // setTimeout firing and aborting the stalled RPC (see test B) -- if
    // anything were left as a truly dangling, uncancelled operation, this
    // promise would never have resolved in fake-timer time at all, and the
    // await above would hang the test itself.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the cooldown-release lease update is also bounded", () => {
  it("runExperimentCycle terminates within its cleanup bound even when the worker_status release update hangs, with no upstream request", async () => {
    vi.useFakeTimers();
    const until = new Date(Date.now() + 90_000).toISOString();
    currentFake = makeFakeSupabase({
      cooldownRow: { blocked_until: until, reason: "429 without Retry-After" },
      workerStatusUpdateHangs: true,
    }).supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    let settled = false;
    let result: Awaited<ReturnType<typeof runExperimentCycle>> | undefined;
    runExperimentCycle(baseExperiment(), "test-worker").then((r) => {
      settled = true;
      result = r;
    });

    // Still waiting on the stalled release just short of its own cleanup bound.
    await vi.advanceTimersByTimeAsync(CLEANUP_RELEASE_DEADLINE_MS_FOR_TEST - 500);
    expect(settled).toBe(false);

    // Past that bound, runExperimentCycle must still return -- fencing means
    // a write that eventually lands late is safe regardless.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(result!.skipped).toMatch(/cooldown active/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("candidate research respects the shared host cooldown", () => {
  it("defers with a clear reason instead of firing its own /trades requests while the host is in cooldown", async () => {
    const until = new Date(Date.now() + 90_000).toISOString();
    currentFake = makeFakeSupabase({
      cooldownRow: { blocked_until: until, reason: "429 without Retry-After" },
    }).supabaseAdmin;

    const result = await candidateResearchIfCycleAndHostAllowForTest(Date.now());
    expect(result.ran).toBe(false);
    expect(result.detail).toMatch(/cooldown active/);
  });
});

describe("the health probe shares one in-flight promise and respects the host cooldown", () => {
  it("concurrent callers within the TTL await the same request instead of firing their own", async () => {
    resetPublicApiProbeCacheForTest();
    currentFake = makeFakeSupabase({ cooldownRow: null }).supabaseAdmin;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse([]);
      }),
    );

    const [a, b, c] = await Promise.all([
      probePublicDataApiForTest(),
      probePublicDataApiForTest(),
      probePublicDataApiForTest(),
    ]);

    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("skips the actual upstream probe and reports WARN while the shared host cooldown is active", async () => {
    resetPublicApiProbeCacheForTest();
    const until = new Date(Date.now() + 90_000).toISOString();
    currentFake = makeFakeSupabase({
      cooldownRow: { blocked_until: until, reason: "429 without Retry-After" },
    }).supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await probePublicDataApiForTest();

    expect(result.status).toBe("WARN");
    expect(result.detail).toMatch(/cooldown active/);
  });

  it("reports WARN (not FAIL) and skips the fetch when the reservation itself is unavailable -- distinct from an actual Polymarket outage", async () => {
    resetPublicApiProbeCacheForTest();
    currentFake = makeFakeSupabase({ cooldownRow: null, reservationThrows: true }).supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await probePublicDataApiForTest();

    expect(result.status).toBe("WARN");
    expect(result.detail).toMatch(/reservation unavailable/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reservation fail-closed propagation into the full ingestion cycle", () => {
  it("a reservation RPC failure: zero upstream fetches, checkpoint never written, lease released as error with poll_failures incremented (same generic error path as any other transient failure)", async () => {
    vi.useFakeTimers();
    const { supabaseAdmin, updateCalls, fromCalls } = makeFakeSupabase({
      cooldownRow: null,
      reservationThrows: true,
    });
    currentFake = supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    let rejected: unknown;
    const promise = runExperimentCycle(baseExperiment(), "test-worker").catch((err) => {
      rejected = err;
    });
    // Every getJson attempt's reservation rejects immediately (no RPC
    // deadline involved -- reservationThrows rejects synchronously), so
    // only the retry+backoff delays between attempts need flushing.
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/reservation/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    // worker_checkpoints is only ever READ (checkpoint_load) -- the success
    // path's checkpoint upsert, which would show up as a second access, is
    // never reached because the reservation failure throws inside
    // fetchSourceWindow, well before `stages` resolves.
    expect(fromCalls.filter((t) => t === "worker_checkpoints")).toHaveLength(1);
    const release = updateCalls.find((u) => u.table === "worker_status");
    expect(release).toBeDefined();
    expect((release!.patch as { state: string }).state).toBe("error");
    expect((release!.patch as { poll_failures: number }).poll_failures).toBe(1);
    expect((release!.patch as { last_error: string }).last_error).toMatch(/reservation/i);
  });

  it("a reservation RPC timeout: zero upstream fetches, same fail-closed error path", async () => {
    vi.useFakeTimers();
    const { supabaseAdmin, updateCalls } = makeFakeSupabase({
      cooldownRow: null,
      reservationHangs: true,
    });
    currentFake = supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    let rejected: unknown;
    const promise = runExperimentCycle(baseExperiment(), "test-worker").catch((err) => {
      rejected = err;
    });

    // Bounded: RESERVATION_RPC_DEADLINE_MS_FOR_TEST (5s) plus the getJson
    // retry loop's own backoff between attempts -- comfortably covered.
    await vi.advanceTimersByTimeAsync(RESERVATION_RPC_DEADLINE_MS_FOR_TEST * 4 + 2_000);
    await promise;

    expect(rejected).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    const release = updateCalls.find((u) => u.table === "worker_status");
    expect((release!.patch as { state: string }).state).toBe("error");
  });

  it("no paper accounting table is ever touched when the reservation fails -- the fake's own unexpected-table guard would have thrown a DIFFERENT error otherwise", async () => {
    vi.useFakeTimers();
    const { supabaseAdmin } = makeFakeSupabase({ cooldownRow: null, reservationThrows: true });
    currentFake = supabaseAdmin;
    vi.stubGlobal("fetch", vi.fn());

    let rejected: unknown;
    const promise = runExperimentCycle(baseExperiment(), "test-worker").catch((err) => {
      rejected = err;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    // If paper_experiments/paper_positions/paper_trades/source_events were
    // ever reached, the fake would throw "unexpected table access: X"
    // instead of the reservation error -- asserting the message proves
    // the failure is specifically the reservation, not a later stage.
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/reservation/i);
  });

  it("a later successful reservation (coordination DB recovered) lets the next scheduler tick proceed normally, resuming catch-up from the same boundary", async () => {
    vi.useFakeTimers();
    const failing = makeFakeSupabase({ cooldownRow: null, reservationThrows: true });
    currentFake = failing.supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    let rejected: unknown;
    const first = runExperimentCycle(baseExperiment(), "tick-1").catch((err) => {
      rejected = err;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await first;
    expect(rejected).toBeInstanceOf(Error);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Next tick: coordination DB has recovered. A fresh runExperimentCycle
    // call (exactly like a real subsequent scheduler invocation) with a
    // working reservation now proceeds through the fetch pipeline --
    // nothing about the previous failure carries over or blocks it.
    const recovered = makeFakeSupabase({ cooldownRow: null });
    currentFake = recovered.supabaseAdmin;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );
    const second = runExperimentCycle(baseExperiment(), "tick-2");
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await second;
    expect(result.skipped).toBeNull();
  });
});

describe("Task 13I / P1-S, P1-T: reserveRequestSlot's optional caller deadline", () => {
  it("T6: omitting callerDeadlineAtMs preserves the exact prior behavior -- an immediate reservation still resolves normally", async () => {
    currentFake = makeFakeSupabase({ cooldownRow: null }).supabaseAdmin;
    await expect(reserveRequestSlot(DATA_API_HOST)).resolves.toBe(0);
  });

  it("throws DeadlineExceededError immediately, without even attempting the RPC, when the caller deadline has already passed", async () => {
    const { supabaseAdmin, rpcCalls } = makeFakeSupabase({ cooldownRow: null });
    currentFake = supabaseAdmin;
    const past = Date.now() - 1;
    await expect(reserveRequestSlot(DATA_API_HOST, past)).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(rpcCalls.some((c) => c.name === "reserve_http_request_slot")).toBe(false);
  });

  it("T2: a genuinely granted reservation whose wait would land at/after the caller's deadline is rejected as DeadlineExceededError, not returned for the caller to sleep through", async () => {
    // Grants a real, in-budget (well under MAX_RESERVATION_LOOKAHEAD_MS) wait of 3s, but
    // the caller's own deadline is only 1s away -- the reservation is genuinely available,
    // just not usable within this caller's remaining time.
    currentFake = makeFakeSupabase({ cooldownRow: null, reservationGrantedInMs: 3_000 }).supabaseAdmin;
    const deadline = Date.now() + 1_000;
    await expect(reserveRequestSlot(DATA_API_HOST, deadline)).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it("a granted reservation that fits comfortably within the caller's deadline still resolves normally with the real wait", async () => {
    currentFake = makeFakeSupabase({ cooldownRow: null, reservationGrantedInMs: 500 }).supabaseAdmin;
    const deadline = Date.now() + 60_000;
    const wait = await reserveRequestSlot(DATA_API_HOST, deadline);
    expect(wait).toBeGreaterThanOrEqual(400); // real wall-clock slack in the test itself
    expect(wait).toBeLessThanOrEqual(600);
  });

  it("T1: the reservation RPC's own timeout is shortened to the caller's remaining time, aborting early as DeadlineExceededError rather than waiting out the full RPC deadline", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    currentFake = makeFakeSupabase({
      cooldownRow: null,
      reservationHangs: true,
      onReservationAbortSignal: (signal) => {
        capturedSignal = signal;
      },
    }).supabaseAdmin;

    const deadline = Date.now() + 1_000; // far shorter than RESERVATION_RPC_DEADLINE_MS_FOR_TEST
    let settled = false;
    let rejected: unknown;
    reserveRequestSlot(DATA_API_HOST, deadline).then(
      () => {
        settled = true;
      },
      (err) => {
        settled = true;
        rejected = err;
      },
    );

    // Not yet at the (shorter) caller deadline.
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    // Past the caller's own deadline -- must abort now, well before
    // RESERVATION_RPC_DEADLINE_MS_FOR_TEST would have fired on its own.
    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBe(true);
    expect(rejected).toBeInstanceOf(DeadlineExceededError);
    expect(capturedSignal?.aborted).toBe(true); // real cancellation, not mere abandonment
  });

  it("a hung RPC with NO caller deadline still falls back to ReservationUnavailableError at the normal RPC deadline (unchanged prior behavior)", async () => {
    vi.useFakeTimers();
    currentFake = makeFakeSupabase({ cooldownRow: null, reservationHangs: true }).supabaseAdmin;

    let settled = false;
    let rejected: unknown;
    reserveRequestSlot(DATA_API_HOST).then(
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
    expect(rejected).not.toBeInstanceOf(DeadlineExceededError);
  });

  it("a reservation exceeding MAX_RESERVATION_LOOKAHEAD_MS remains ReservationUnavailableError even when a caller deadline is also supplied and would independently reject it -- the queue-full reason is reported, since it is checked first", async () => {
    currentFake = makeFakeSupabase({ cooldownRow: null, reservationGrantedInMs: MAX_RESERVATION_LOOKAHEAD_MS_FOR_TEST + 1_000 }).supabaseAdmin;
    const deadline = Date.now() + 500; // would also reject the wait, but the lookahead check runs first
    await expect(reserveRequestSlot(DATA_API_HOST, deadline)).rejects.toBeInstanceOf(ReservationUnavailableError);
  });
});
