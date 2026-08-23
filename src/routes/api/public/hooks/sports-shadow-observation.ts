import { createFileRoute } from "@tanstack/react-router";

/**
 * CODEX P2-1: independent bounded scheduler hook for the Sports Forward Shadow
 * OBSERVATION job -- split out of the combined sports-shadow.ts route (see that
 * route's own updated doc comment) so this time-critical, per-venue-leased lane
 * (worst case ~16s -- see worker.server.ts's OBSERVATION-LANE LATENCY AUDIT) can run
 * on its own tight, independent cadence without ever contending with or waiting behind
 * the source/matching job's own much slower (~42s worst case) lane.
 *
 * Same security/authorization contract as every other Sports Shadow scheduler hook:
 * SPORTS_SHADOW_HOOK_SECRET is the ONLY accepted credential, config is validated (and
 * fails closed) before any work begins, no credentials/signing/order-placement path
 * anywhere in this route or the modules it calls.
 */
async function handle(request: Request): Promise<Response> {
  const provided = request.headers.get("x-sports-shadow-secret");
  const expected = process.env["SPORTS_SHADOW_HOOK_SECRET"];

  const { checkSportsShadowSecret, parseSportsShadowConfig } = await import("@/lib/sports-shadow/config");
  if (!checkSportsShadowSecret(provided, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const configResult = parseSportsShadowConfig(process.env as Record<string, string | undefined>);
  if (!configResult.ok) {
    return Response.json({ ok: false, error: configResult.reason });
  }

  const { runSportsShadowCycle } = await import("@/lib/sports-shadow/worker.server");
  try {
    const summary = await runSportsShadowCycle(configResult.config, {}, "observation");
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "sports shadow observation job failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/hooks/sports-shadow-observation")({
  server: {
    handlers: {
      // Mutating scheduler hook is POST-only. GET must remain side-effect free.
      POST: ({ request }) => handle(request),
    },
  },
});
