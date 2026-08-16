import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled ingestion endpoint for the autonomous follower.
 * Called by the database scheduler (and optionally by the standalone worker),
 * so the follower keeps running with no browser open.
 * Read-only against public Polymarket data; no trading credentials or order placement.
 *
 * INGEST_HOOK_SECRET is the only accepted scheduler credential. The former
 * publishable-key fallback has been removed: a browser-visible key must never
 * be able to drive a mutating scheduler hook.
 */
async function handle(request: Request): Promise<Response> {
  const provided =
    request.headers.get("x-ingest-secret") ?? request.headers.get("apikey") ?? "";
  const expected = process.env["INGEST_HOOK_SECRET"] ?? "";
  if (!expected || provided !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const workerId = url.searchParams.get("worker") ?? "scheduler";

  const { runIngestCycle } = await import("@/lib/shadow.server");
  try {
    const result = await runIngestCycle(workerId);

    let researchPersistence: { ok: boolean; issues: number } | null = null;
    if (result.candidateResearch.ran) {
      try {
        const { verifyCandidateResearchPersistence } = await import("@/lib/candidates/consistency.server");
        const check = await verifyCandidateResearchPersistence({ downgradeRunState: true });
        researchPersistence = { ok: check.ok, issues: check.issues.length };
      } catch {
        // Research consistency is diagnostic/fail-visible through worker state;
        // it must never turn a successful ingestion cycle into a failed poll.
        researchPersistence = { ok: false, issues: -1 };
      }
    }

    // Queue actual paper-BUY alerts only after the full ingest cycle has
    // completed and all worker leases/accounting transactions are closed. The
    // producer scans the durable paper_trades ledger from its own cursor, not
    // the current cycle summary, so a BUY remains recoverable even when a
    // later stage of the cycle failed after paper processing committed it.
    let paperBuyNotifications = { buysFound: 0, alertsQueued: 0, cursorAdvanced: false };
    try {
      const { queuePaperBuyNotifications } = await import("@/lib/paper-buy-notifications.server");
      paperBuyNotifications = await queuePaperBuyNotifications();
    } catch {
      // Notification production is best-effort and must never fail ingestion.
      // The durable cursor stays behind, so the next scheduler run retries the
      // same persisted BUYs instead of losing them.
    }

    // Notification delivery is deliberately failure-isolated from ingestion.
    // A Telegram outage must never make a successful source/paper cycle fail,
    // but failed important alerts should be retried automatically on later cron runs.
    let notifications = { attempted: 0, sent: 0 };
    try {
      const { retryPendingTelegramAlerts } = await import("@/lib/notify.server");
      notifications = await retryPendingTelegramAlerts(20);
    } catch {
      // Best-effort only; delivery state remains pending/failed for a later retry.
    }

    return Response.json({
      ok: true,
      ...result,
      researchPersistence,
      paperBuyNotifications,
      notifications,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "ingest failed" },
      { status: 500 },
    );
  }
}

export const Route = createFileRoute("/api/public/hooks/ingest")({
  server: {
    handlers: {
      // Mutating scheduler hooks are POST-only. GET must remain side-effect free.
      POST: ({ request }) => handle(request),
    },
  },
});
