import { createFileRoute } from "@tanstack/react-router";

/**
 * CODEX P2-1: independent bounded scheduler hook for the Sports Forward Shadow
 * SETTLEMENT job -- runSettlementBatch (settlement.orchestrator.server.ts) had NO call
 * site anywhere in the app before this pass. This is that call site: its own lease
 * (SETTLEMENT_LOCK_ID), its own bounded deadline (SETTLEMENT_BATCH_BUDGET_MS), its own
 * telemetry/heartbeat -- see runSportsShadowSettlementJob's own doc comment
 * (worker.server.ts).
 *
 * Gated by the SAME SPORTS_SHADOW_ENABLED/config validation as every other Sports
 * Shadow scheduler hook: an unconfigured or disabled deployment never checks a single
 * settlement. Never mutates production trading state -- this only ever reads each
 * venue's public settlement/resolution endpoint and writes to sports_shadow_settlements
 * (a research/paper-P&L record), the same no-order-placement contract every other
 * Sports Shadow route already holds.
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

  const { runSportsShadowSettlementJob } = await import("@/lib/sports-shadow/worker.server");
  try {
    const summary = await runSportsShadowSettlementJob();
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "sports shadow settlement job failed" }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/hooks/sports-shadow-settlement")({
  server: {
    handlers: {
      // Mutating scheduler hook is POST-only. GET must remain side-effect free.
      POST: ({ request }) => handle(request),
    },
  },
});
