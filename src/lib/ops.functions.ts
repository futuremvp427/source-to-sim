import { createServerFn } from "@tanstack/react-start";

import type { ComparisonData } from "./comparison.server";
import type { HealthReport } from "./health.server";

/** Fair-comparison read model for every enabled shadow experiment. Read-only. */
export const getComparison = createServerFn({ method: "GET" }).handler(
  async (): Promise<ComparisonData> => {
    const { loadComparison } = await import("./comparison.server");
    return loadComparison();
  },
);

/** Compact PASS / WARN / FAIL system self-check. Read-only. */
export const getSelfCheck = createServerFn({ method: "GET" }).handler(
  async (): Promise<HealthReport> => {
    const { runSelfCheck } = await import("./health.server");
    return runSelfCheck();
  },
);

/** Compact V2 fair-comparison cohort status. Read-only. */
export const getV2Status = createServerFn({ method: "GET" }).handler(async () => {
  const { loadV2Status } = await import("./v2-status.server");
  return loadV2Status();
});
