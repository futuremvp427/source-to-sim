import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled ingestion endpoint for the autonomous follower.
 * Called by the database scheduler (and optionally by the standalone worker),
 * so the follower keeps running with no browser open.
 * Read-only against public Polymarket data; no credentials, no order placement.
 */
async function handle(request: Request): Promise<Response> {
  const provided = request.headers.get("apikey") ?? "";
  const expected = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? "";
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
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
    },
  },
});
