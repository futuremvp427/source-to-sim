import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAdmin } from "./admin-auth";
import type { PmusConnectionStatus, PmusPanelData } from "./pmus/verify.server";
import type { PmusAuthDiagnosis } from "./pmus/diagnose.server";

/** Safe auth diagnostics: metadata only, never credentials or signatures. */
export const diagnosePmusAuthFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async (): Promise<PmusAuthDiagnosis> => {
    const { diagnosePmusAuth } = await import("./pmus/diagnose.server");
    return diagnosePmusAuth();
  });

/** Account Setup + Approval Queue read model. Never returns credentials. Admin-only. */
export const getPmusPanel = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async (): Promise<PmusPanelData> => {
    const { loadPmusPanel } = await import("./pmus/verify.server");
    return loadPmusPanel();
  });

/** Verify the Polymarket US connection with read-only balances + positions. */
export const verifyPmusConnectionFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async (): Promise<PmusConnectionStatus> => {
    const { verifyPmusConnection } = await import("./pmus/verify.server");
    return verifyPmusConnection();
  });

const decisionSchema = z.object({
  previewId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

/**
 * Approve = READY_FOR_MANUAL_EXECUTION. Reject = REJECTED.
 * No live-order endpoint is reachable from here.
 *
 * The underlying UPDATE intentionally only matches PENDING_APPROVAL rows. We
 * verify the persisted status after the write so an already-decided/missing row
 * can never be reported to the UI as a successful transition merely because
 * PostgreSQL returned no statement-level error.
 */
export const decidePmusPreview = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: unknown) => decisionSchema.parse(input))
  .handler(async ({ data }) => {
    const { decidePreview } = await import("./pmus/previews.server");
    const result = await decidePreview(data.previewId, data.decision);
    if (!result.ok) return result;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const expected = data.decision === "approve" ? "READY_FOR_MANUAL_EXECUTION" : "REJECTED";
    const { data: row, error } = await supabaseAdmin
      .from("order_previews")
      .select("status")
      .eq("id", data.previewId)
      .maybeSingle();
    if (error) return { ok: false as const, error: "Could not verify the preview decision." };
    if (!row || row.status !== expected) {
      return {
        ok: false as const,
        error: "Preview decision was not applied. It may already have been decided or no longer be pending.",
      };
    }
    return { ok: true as const };
  });
