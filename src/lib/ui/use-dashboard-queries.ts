/**
 * Shared read-only queries for the dashboard shell. Both hooks use stable query
 * keys so every panel reuses one cached response instead of refetching per card.
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getMasterPortfolio } from "@/lib/ops.functions";
import { getShadowDashboard } from "@/lib/shadow.functions";
import { getSportsShadowDashboard } from "@/lib/sports-shadow.functions";

export const DASHBOARD_REFRESH_MS = 20_000;

export function useMasterPortfolio() {
  const fetchMaster = useServerFn(getMasterPortfolio);
  return useQuery({
    queryKey: ["master-portfolio"],
    queryFn: () => fetchMaster(),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
}

export function useShadowDashboard() {
  const fetchDashboard = useServerFn(getShadowDashboard);
  return useQuery({
    queryKey: ["shadow-dashboard"],
    queryFn: () => fetchDashboard(),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
}

export function useSportsShadowDashboard() {
  const fetchDashboard = useServerFn(getSportsShadowDashboard);
  return useQuery({
    queryKey: ["sports-shadow-dashboard"],
    queryFn: () => fetchDashboard(),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
}