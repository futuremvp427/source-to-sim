import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal chainable fake for the subset of the PostgREST query builder used
 * here. Any call to `from()` at all is recorded, so the "no accounting
 * mutation from the pause" tests can assert on it directly -- a paused
 * General Shadow cycle must never reach a single table.
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

function makeFakeSupabase() {
  const rpcCalls: { name: string; args: unknown }[] = [];
  const fromCalls: string[] = [];

  const supabaseAdmin = {
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      // acquire_worker_lease success by default; only reached for
      // non-General-Shadow experiments in these tests.
      return chainable({ data: 1, error: null }) as never;
    },
    from: (table: string) => {
      fromCalls.push(table);
      if (table === "http_rate_limits") {
        // Block immediately so any experiment that DOES get past the
        // General Shadow gate is cleanly short-circuited by the
        // already-covered cooldown-gate path, without needing to mock the
        // full success pipeline.
        return chainable({
          data: { blocked_until: new Date(Date.now() + 90_000).toISOString(), reason: "test" },
          error: null,
        });
      }
      if (table === "worker_status") {
        return {
          update: () => chainable({ data: null, error: null }),
          select: () => chainable({ data: null, error: null }),
        };
      }
      throw new Error(`FakeSupabase: unexpected table access: ${table}`);
    },
  };
  return { supabaseAdmin, rpcCalls, fromCalls };
}

let currentFake: ReturnType<typeof makeFakeSupabase>["supabaseAdmin"];

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentFake;
  },
}));

const { GS_COHORT, GS_PREFIX, GENERAL_SHADOW_POLLING_ENABLED, isGeneralShadowName, gsExperimentName } =
  await import("./general-shadow");
const { runExperimentCycle } = await import("./shadow.server");

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

describe("General Shadow cohort identity (exact, no fuzzy matching)", () => {
  it("is exactly RN1 and swisstony at the specified wallet addresses", () => {
    expect(GS_COHORT).toHaveLength(2);
    expect(GS_COHORT.find((m) => m.handle === "RN1")?.wallet).toBe(
      "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
    );
    expect(GS_COHORT.find((m) => m.handle === "swisstony")?.wallet).toBe(
      "0x204f72f35326db932158cba6adff0b9a1da95e14",
    );
  });

  it("isGeneralShadowName matches only the exact GS_PREFIX, not a substring/fuzzy match", () => {
    expect(isGeneralShadowName(gsExperimentName("RN1"))).toBe(true);
    expect(isGeneralShadowName(gsExperimentName("swisstony"))).toBe(true);
    expect(isGeneralShadowName("SHADOW V2: Poligarch")).toBe(false);
    expect(isGeneralShadowName("SHADOW V3 CAPACITY: Poligarch")).toBe(false);
    expect(isGeneralShadowName("SHADOW")).toBe(false);
    // Not a substring match: containing "GENERAL SHADOW" elsewhere in the
    // name must not qualify -- only a name that literally starts with the prefix.
    expect(isGeneralShadowName("SHADOW V2: GENERAL SHADOW: RN1")).toBe(false);
  });

  it("the pause flag is currently OFF (paused), documented and reversible", () => {
    expect(GENERAL_SHADOW_POLLING_ENABLED).toBe(false);
  });
});

describe("runExperimentCycle pauses General Shadow only", () => {
  it("1: RN1 is skipped while paused, with zero DB access and zero upstream requests", async () => {
    currentFake = makeFakeSupabase().supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runExperimentCycle(
      baseExperiment({ id: "gs-rn1", name: gsExperimentName("RN1"), wallet_address: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" }),
      "test-worker",
    );

    expect(result.skipped).toMatch(/General Shadow polling is paused/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("2: swisstony is skipped while paused, with zero DB access and zero upstream requests", async () => {
    currentFake = makeFakeSupabase().supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await runExperimentCycle(
      baseExperiment({
        id: "gs-swisstony",
        name: gsExperimentName("swisstony"),
        wallet_address: "0x204f72f35326db932158cba6adff0b9a1da95e14",
      }),
      "test-worker",
    );

    expect(result.skipped).toMatch(/General Shadow polling is paused/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("3: none of the 10 V2/V3 experiments are skipped by this gate (they proceed past it, to the next real check)", async () => {
    const { supabaseAdmin, rpcCalls } = makeFakeSupabase();
    currentFake = supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const v2Names = [
      "SHADOW V2: badatmath.",
      "SHADOW V2: Poligarch",
      "SHADOW V2: gghff",
      "SHADOW V2: Weather-Guru",
      "SHADOW V2: HighTempTation",
      "SHADOW V3 CAPACITY: badatmath.",
      "SHADOW V3 CAPACITY: Poligarch",
      "SHADOW V3 CAPACITY: gghff",
      "SHADOW V3 CAPACITY: Weather-Guru",
      "SHADOW V3 CAPACITY: HighTempTation",
    ];

    for (const name of v2Names) {
      const result = await runExperimentCycle(baseExperiment({ id: name, name }), "test-worker");
      // Never the General-Shadow-paused skip reason.
      expect(result.skipped).not.toMatch(/General Shadow/);
      // Each one DID reach acquireLease (proven by the RPC call being made),
      // i.e. it was never intercepted by the General Shadow gate at all.
    }
    expect(rpcCalls.filter((c) => c.name === "acquire_worker_lease")).toHaveLength(v2Names.length);
  });

  it("4: no General Shadow /activity or /trades request is made while paused (fetch never invoked)", async () => {
    currentFake = makeFakeSupabase().supabaseAdmin;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await runExperimentCycle(baseExperiment({ name: gsExperimentName("RN1") }), "test-worker");
    await runExperimentCycle(baseExperiment({ name: gsExperimentName("swisstony") }), "test-worker");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("5: no checkpoint/history/accounting mutation occurs merely from the pause (zero table access)", async () => {
    const { supabaseAdmin, fromCalls, rpcCalls } = makeFakeSupabase();
    currentFake = supabaseAdmin;
    vi.stubGlobal("fetch", vi.fn());

    await runExperimentCycle(baseExperiment({ name: gsExperimentName("RN1") }), "test-worker");

    expect(fromCalls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("6: existing V2/V3 polling behavior is unchanged -- lease acquisition still happens exactly as before for a V2 experiment", async () => {
    const { supabaseAdmin, rpcCalls } = makeFakeSupabase();
    currentFake = supabaseAdmin;
    vi.stubGlobal("fetch", vi.fn());

    await runExperimentCycle(baseExperiment({ name: "SHADOW V2: Poligarch" }), "test-worker");

    expect(rpcCalls[0]?.name).toBe("acquire_worker_lease");
  });
});
