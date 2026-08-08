import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAdmin } from "./admin-auth";
import type { CandidatePanelData, PromotionResult, ResearchSummary } from "./candidates/research.server";

/** Read model for the Research / Candidate Watchlist panel. Read-only. */
export const getCandidatePanel = createServerFn({ method: "GET" }).handler(
  async (): Promise<CandidatePanelData> => {
    const { verifyCandidateResearchPersistence } = await import("./candidates/consistency.server");
    const consistency = await verifyCandidateResearchPersistence();
    if (!consistency.ok) {
      throw new Error(
        `Candidate research state is inconsistent for ${consistency.issues.length} candidate(s); refusing to present stale mixed-version scores.`,
      );
    }
    const { loadCandidatePanel } = await import("./candidates/research.server");
    return loadCandidatePanel();
  },
);

/** Bounded PUBLIC research pass over the seeded candidates. No credentials, no orders. */
export const runCandidateResearchFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async (): Promise<{ ok: true; summary: ResearchSummary } | { ok: false; error: string }> => {
    const { runCandidateResearch } = await import("./candidates/research.server");
    try {
      const summary = await runCandidateResearch();
      if (summary.state !== "skipped_locked") {
        const { verifyCandidateResearchPersistence } = await import("./candidates/consistency.server");
        const consistency = await verifyCandidateResearchPersistence({ downgradeRunState: true });
        if (!consistency.ok) {
          return {
            ok: false,
            error: `Research persistence check failed for ${consistency.issues.length} candidate(s); run state was downgraded to partial.`,
          };
        }
      }
      return { ok: true, summary };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "research pass failed" };
    }
  });

const idSchema = z.object({ candidateId: z.string().uuid() });

/** Creates an isolated PAUSED research experiment. Does NOT start following. */
export const promoteCandidateFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: unknown) => idSchema.parse(input))
  .handler(async ({ data }): Promise<PromotionResult> => {
    const { promoteCandidate } = await import("./candidates/research.server");
    return promoteCandidate(data.candidateId);
  });

const statusSchema = idSchema.extend({
  status: z.enum(["RESEARCH", "REJECTED", "INSUFFICIENT_DATA"]),
});

export const setCandidateStatusFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: unknown) => statusSchema.parse(input))
  .handler(async ({ data }) => {
    const { setCandidateStatus } = await import("./candidates/research.server");
    return setCandidateStatus(data.candidateId, data.status);
  });
