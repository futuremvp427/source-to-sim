import { createServerFn } from "@tanstack/react-start";

import type { SportsShadowDashboardData } from "./sports-shadow/dashboard.server";

/** Read model for the Sports Shadow dashboard. Read-only -- mirrors getShadowDashboard's own no-auth-middleware precedent in shadow.functions.ts (read-only research data, never a trading control). */
export const getSportsShadowDashboard = createServerFn({ method: "GET" }).handler(async (): Promise<SportsShadowDashboardData> => {
  const { loadSportsShadowDashboard } = await import("./sports-shadow/dashboard.server");
  return loadSportsShadowDashboard();
});
