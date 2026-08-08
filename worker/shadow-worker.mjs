#!/usr/bin/env node
/**
 * Optional standalone follower worker.
 *
 * The app already runs autonomously via the database scheduler calling
 * /api/public/hooks/ingest. This script is for running the same loop from your
 * own machine or a VPS. It calls only the scheduler hook; it never signs or
 * submits Polymarket orders.
 *
 * Usage:
 *   SHADOW_URL="https://<your-app>/api/public/hooks/ingest" \
 *   SHADOW_HOOK_SECRET="<INGEST_HOOK_SECRET>" \
 *   node worker/shadow-worker.mjs
 */

const url = process.env.SHADOW_URL;
const hookSecret = process.env.SHADOW_HOOK_SECRET;
const workerId = process.env.SHADOW_WORKER_ID ?? `standalone-${process.pid}`;
const baseInterval = Number(process.env.SHADOW_INTERVAL_SECONDS ?? 60) * 1000;

if (!url || !hookSecret) {
  console.error("SHADOW_URL and SHADOW_HOOK_SECRET are required.");
  process.exit(1);
}

let failures = 0;
let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

while (running) {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${url}?worker=${encodeURIComponent(workerId)}`, {
      method: "POST",
      headers: { apikey: hookSecret, "content-type": "application/json" },
    });
    const body = await res.json();
    if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);

    failures = 0;
    const cycles = Array.isArray(body.cycles) ? body.cycles : [];
    const totals = cycles.reduce(
      (acc, cycle) => {
        acc.newEvents += Number(cycle?.newEvents ?? 0);
        acc.processed += Number(cycle?.process?.processed ?? 0);
        acc.skips += Number(cycle?.process?.skips ?? 0);
        if (cycle?.skipped) acc.skippedCycles += 1;
        return acc;
      },
      { newEvents: 0, processed: 0, skips: 0, skippedCycles: 0 },
    );
    console.log(
      new Date().toISOString(),
      `experiments=${Number(body.experiments ?? cycles.length)}`,
      `new=${totals.newEvents}`,
      `processed=${totals.processed}`,
      `skips=${totals.skips}`,
      `skippedCycles=${totals.skippedCycles}`,
    );
  } catch (err) {
    failures += 1;
    console.error(new Date().toISOString(), "poll failed:", err instanceof Error ? err.message : String(err));
  }

  // Exponential backoff on repeated failures, capped at 10 minutes.
  const wait = failures > 0 ? Math.min(baseInterval * 2 ** Math.min(failures, 4), 600_000) : baseInterval;
  const elapsed = Date.now() - startedAt;
  await sleep(Math.max(1000, wait - elapsed));
}

console.log("worker stopped");
