import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { PmusConnectionStatus, PmusPanelData } from "./pmus/verify.server";

/** Account Setup + Approval Queue read model. Never returns credentials. */
export const getPmusPanel = createServerFn({ method: "GET" }).handler(
  async (): Promise<PmusPanelData> => {
    const { loadPmusPanel } = await import("./pmus/verify.server");
    return loadPmusPanel();
  },
);

/** Verify the Polymarket US connection with read-only balances + positions. */
export const verifyPmusConnectionFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<PmusConnectionStatus> => {
    const { verifyPmusConnection } = await import("./pmus/verify.server");
    return verifyPmusConnection();
  },
);

const decisionSchema = z.object({
  previewId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

/**
 * Approve = READY_FOR_MANUAL_EXECUTION. Reject = REJECTED.
 * No live-order endpoint is reachable from here.
 */
export const decidePmusPreview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => decisionSchema.parse(input))
  .handler(async ({ data }) => {
    const { decidePreview } = await import("./pmus/previews.server");
    return decidePreview(data.previewId, data.decision);
  });