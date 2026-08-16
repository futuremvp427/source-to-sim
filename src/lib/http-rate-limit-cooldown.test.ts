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
    maybeSingle: () => Promise<typeof result>;
    then: (resolve: (v: typeof result) => void) => void;
  } = {
    select: () => builder,
    update: () => builder,
    eq: () => builder,
    maybeSingle: async () => result,
    then: (resolve) => resolve(result),
  };
  return builder;
}

type CooldownRow = { blocked_until: string; reason: string } | null;

function makeFakeSupabase(opts: {
  cooldownRow: CooldownRow | "error";
  leaseFence?: number | null;
}) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const fromCalls: string[] = [];
  const updateCalls: { table: string; patch: unknown }[] = [];

  const supabaseAdmin = {
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === "acquire_worker_lease") {
        return { data: opts.leaseFence === undefined ? 1 : opts.leaseFence, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      fromCalls.push(table);
      if (table === "http_rate_limits") {
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
            return chainable({ data: null, error: null });
          },
          select: () => chainable({ data: null, error: null }),
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
  DATA_API_HOST,
  MIN_COOLDOWN_MS_FOR_TEST,
  DEFAULT_COOLDOWN_MS_FOR_TEST,
  MAX_COOLDOWN_MS_FOR_TEST,
} = await import("./http-rate-limit.server");
const { runExperimentCycle, getJsonForTest, buildTradesUrl } = await import("./shadow.server");
const { ingestGeneralActivity } = await import("./general-shadow.server");

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
    currentFake = {
      rpc: async () => {
        throw new Error("network down");
      },
      from: () => {
        throw new Error("should not be called");
      },
    } as never;
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
    const { supabaseAdmin, updateCalls } = makeFakeSupabase({
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
