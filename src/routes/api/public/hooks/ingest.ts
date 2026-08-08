import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled ingestion endpoint for the autonomous follower.
 * Called by the database scheduler (and optionally by the standalone worker),
 * so the follower keeps running with no browser open.
 * Read-only against public Polymarket data; no trading credentials or order placement.
 *
 * INGEST_HOOK_SECRET is the intended private scheduler credential. The
 * publishable-key fallback is temporary backwards compatibility for existing
 * deployments and should be removed once the live pg_cron job is rotated.
 */
async function handle(request: Request): Promise<Response> {
  const provided = request.headers.get("apikey") ?? "";
  const privateSecret = process.env["INGEST_HOOK_SECRET"] ?? "";
  const legacyPublishable = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? "";
  const expected = privateSecret || legacyPublishable;
  if (!expected || provided !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const workerId = url.searchParams.get("worker") ?? "scheduler";

  const { runIngestCycle } = await import("@/lib/shadow.server");
  try {
    const result = await runIngestCycle(workerId);
    return Response.json({ ok: true, ...result });
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
