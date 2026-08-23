import { createFileRoute } from "@tanstack/react-router";

/**
 * Bounded scheduler hook for the Sports Forward Shadow worker's SOURCE/MATCHING job
 * (Task 11). CODEX P2-1: this route used to run the FULL combined cycle (observation +
 * source + a final observation catch-pass) behind one HTTP call, whose worst case
 * (~72s) could exceed both the cron cadence and pg_net's own per-invocation timeout --
 * see the scheduler artifact's own doc comment for the full analysis. It now runs ONLY
 * the source/matching lane (`lanes: "source"`, worst case ~42s) -- observation capture
 * and settlement each have their own independently-scheduled route/lease/deadline/
 * heartbeat (sports-shadow-observation.ts / sports-shadow-settlement.ts).
 *
 * Called by an external scheduler repeatedly, tolerant of early/late/skipped/
 * overlapping/retried invocations — see src/lib/sports-shadow/worker.server.ts's own
 * doc comment for the lease design. Read-only against public PM-US/Kalshi endpoints and
 * Task 10's paced Polymarket trade history fetch; writes only to the sports_shadow_*
 * tables. No credentials, no signing, no order-placement path anywhere in this route or
 * the modules it calls.
 *
 * SPORTS_SHADOW_HOOK_SECRET is the ONLY accepted scheduler credential — dedicated to
 * this hook, never falls back to a Supabase anon/publishable/browser-visible key.
 */
async function handle(request: Request): Promise<Response> {
  const provided = request.headers.get("x-sports-shadow-secret");
  const expected = process.env["SPORTS_SHADOW_HOOK_SECRET"];

  const { checkSportsShadowSecret, parseSportsShadowConfig } = await import("@/lib/sports-shadow/config");
  if (!checkSportsShadowSecret(provided, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Configuration is validated (and fails closed) BEFORE any source-trigger generation
  // or network work begins — an enabled-but-malformed config never reaches the cycle.
  const configResult = parseSportsShadowConfig(process.env as Record<string, string | undefined>);
  if (!configResult.ok) {
    return Response.json({ ok: false, error: configResult.reason });
  }

  const { runSportsShadowCycle } = await import("@/lib/sports-shadow/worker.server");
  try {
    const summary = await runSportsShadowCycle(configResult.config, {}, "source");
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "sports shadow cycle failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/hooks/sports-shadow")({
  server: {
    handlers: {
      // Mutating scheduler hook is POST-only. GET must remain side-effect free.
      POST: ({ request }) => handle(request),
    },
  },
});
