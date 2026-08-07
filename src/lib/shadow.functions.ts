import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { DashboardData } from "./shadow.server";

/** Read model for the dashboard. Read-only. */
export const getShadowDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<DashboardData> => {
    const { loadDashboard } = await import("./shadow.server");
    return loadDashboard();
  },
);

/** Manually trigger one ingest cycle (the scheduled worker does this automatically). */
export const triggerIngest = createServerFn({ method: "POST" }).handler(async () => {
  const { runIngestCycle } = await import("./shadow.server");
  try {
    const result = await runIngestCycle("manual-ui");
    return { ok: true as const, result };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "ingest failed" };
  }
});

const settingsSchema = z.object({
  buyAmount: z.number().min(0.5).max(1000).optional(),
  pollIntervalSeconds: z.number().int().min(15).max(3600).optional(),
  enabled: z.boolean().optional(),
  weatherOnly: z.boolean().optional(),
});

/** Update follower settings. Simulation-only knobs; nothing here can place an order. */
export const updateShadowSettings = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => settingsSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { EXPERIMENT_NAME } = await import("./shadow.server");
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.buyAmount !== undefined) patch["buy_amount"] = data.buyAmount;
    if (data.pollIntervalSeconds !== undefined)
      patch["poll_interval_seconds"] = data.pollIntervalSeconds;
    if (data.enabled !== undefined) patch["enabled"] = data.enabled;
    if (data.weatherOnly !== undefined) patch["weather_only"] = data.weatherOnly;
    const { error } = await supabaseAdmin
      .from("paper_experiments")
      .update(patch as never)
      .eq("name", EXPERIMENT_NAME);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

/** Force a full replay-based reconciliation of source position state. */
export const runReconciliation = createServerFn({ method: "POST" }).handler(async () => {
  const { reconcile } = await import("./shadow.server");
  try {
    const result = await reconcile();
    return { ok: true as const, mismatches: result.mismatches, reconciled: result.ok };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "reconcile failed" };
  }
});

export const acknowledgeAlerts = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("alerts").update({ acknowledged: true }).eq("acknowledged", false);
  return { ok: true as const };
});
