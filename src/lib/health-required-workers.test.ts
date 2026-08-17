import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Generic chainable fake covering every select-chain shape runSelfCheck
 * issues (eq/gt/gte/order/limit/maybeSingle), plus a `head:true` count
 * response for the one head-count query. Table-specific data is supplied
 * via `tableData`; anything not configured returns an empty result so
 * unrelated checks stay neutral (PASS-shaped) rather than erroring.
 */
function chainable(result: { data: unknown; error: unknown; count?: number | null }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    gt: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => result,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return builder;
}

function makeFakeSupabase(opts: {
  experiments: { id: string; name: string; enabled: boolean }[];
  workerStatus: Record<string, unknown>[];
}) {
  const supabaseAdmin = {
    from: (table: string) => {
      if (table === "source_events") {
        return chainable({ data: null, error: null, count: 0 });
      }
      if (table === "paper_experiments") {
        return chainable({ data: opts.experiments, error: null });
      }
      if (table === "worker_status") {
        return chainable({ data: opts.workerStatus, error: null });
      }
      if (table === "alerts") {
        return chainable({ data: [], error: null });
      }
      if (table === "paper_positions") {
        return chainable({ data: [], error: null });
      }
      if (table === "integration_status") {
        return chainable({ data: null, error: null });
      }
      throw new Error(`unexpected table in health-required-workers test: ${table}`);
    },
  };
  return supabaseAdmin;
}

let currentFake: ReturnType<typeof makeFakeSupabase>;
let generalShadowPollingEnabled = false;

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return currentFake;
  },
}));
vi.mock("./http-rate-limit.server", () => ({
  DATA_API_HOST: "data-api.polymarket.com",
  getHostCooldown: async () => ({ blocked: false, until: null, reason: null }),
  reserveRequestSlot: async () => 0,
}));
vi.mock("./general-shadow", () => ({
  get GENERAL_SHADOW_POLLING_ENABLED() {
    return generalShadowPollingEnabled;
  },
  isGeneralShadowName: (name: string) => name.startsWith("GENERAL SHADOW: "),
}));

const { runSelfCheck } = await import("./health.server");

afterEach(() => {
  vi.unstubAllGlobals();
  generalShadowPollingEnabled = false;
});

function gsExperiment(id: string, handle: string) {
  return { id, name: `GENERAL SHADOW: ${handle}`, enabled: true };
}
function v2Experiment(id: string, name: string) {
  return { id, name, enabled: true };
}
function freshWorkerRow(id: string) {
  return {
    id,
    state: "idle",
    heartbeat_at: new Date().toISOString(),
    last_poll_at: new Date().toISOString(),
    last_success_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    poll_failures: 0,
  };
}

describe("runSelfCheck: General Shadow's intentional pause must not fail the required-worker check", () => {
  it("PASSes when only General Shadow experiments have never completed a cycle, while polling is paused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    currentFake = makeFakeSupabase({
      experiments: [
        v2Experiment("v2-1", "SHADOW V2: Poligarch"),
        gsExperiment("gs-1", "RN1"),
        gsExperiment("gs-2", "swisstony"),
      ],
      // Only the V2 experiment has ever completed a cycle; the two General
      // Shadow rows are missing entirely, exactly as they would be if
      // runExperimentCycle has always short-circuited before touching
      // worker_status for them.
      workerStatus: [freshWorkerRow("ingest:v2-1")],
    });

    const report = await runSelfCheck();
    const schedule = report.checks.find((c) => c.id === "schedule");
    expect(schedule?.status).toBe("PASS");
    expect(schedule?.detail).toMatch(/All 1 required worker/);
  });

  it("still FAILs on a genuinely missing V2/V3 worker even while General Shadow is paused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    currentFake = makeFakeSupabase({
      experiments: [
        v2Experiment("v2-1", "SHADOW V2: Poligarch"),
        gsExperiment("gs-1", "RN1"),
      ],
      // The V2 experiment itself has never completed a cycle -- a real
      // failure, unrelated to the General Shadow pause.
      workerStatus: [],
    });

    const report = await runSelfCheck();
    const schedule = report.checks.find((c) => c.id === "schedule");
    expect(schedule?.status).toBe("FAIL");
    // classifyWorker reports a missing row generically (id "missing"), but
    // the point of this test is that it fired at all -- with a real V2
    // failure present, the check must not be masked green by the unrelated
    // General Shadow exclusion.
    expect(schedule?.detail).toMatch(/No worker row recorded/);
    expect(schedule?.detail).not.toMatch(/gs-1/);
  });

  it("requires General Shadow again once polling is re-enabled", async () => {
    generalShadowPollingEnabled = true;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    currentFake = makeFakeSupabase({
      experiments: [gsExperiment("gs-1", "RN1")],
      workerStatus: [],
    });

    const report = await runSelfCheck();
    const schedule = report.checks.find((c) => c.id === "schedule");
    expect(schedule?.status).toBe("FAIL");
    expect(schedule?.detail).toMatch(/No worker row recorded/);
  });
});
