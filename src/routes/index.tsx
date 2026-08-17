import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

import { ActivityView } from "@/components/mirror/activity-view";
import { OverviewView } from "@/components/mirror/overview-view";
import { ResearchView } from "@/components/mirror/research-view";
import { Shell, type TabKey } from "@/components/mirror/shell";
import { StrategiesView } from "@/components/mirror/strategies-view";
import { SystemView } from "@/components/mirror/system-view";
import { useShadowDashboard } from "@/lib/ui/use-dashboard-queries";
import { isWorkerHealthy } from "@/lib/worker-health";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MirrorWeather Shadow Bot — Paper Copy Follower" },
      {
        name: "description",
        content:
          "Autonomous read-only Polymarket wallet follower with a persistent paper-copy simulation: source trades, proportional paper fills, positions, P&L, worker health.",
      },
      { property: "og:title", content: "MirrorWeather Shadow Bot — Paper Copy Follower" },
      {
        property: "og:description",
        content:
          "Persistent, autonomous paper-copy follower for a fixed Polymarket wallet. Simulation only — no orders, no credentials.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const [tab, setTab] = useState<TabKey>("overview");
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [operatorEmail, setOperatorEmail] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data } = useShadowDashboard();

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setOperatorEmail(data.user?.email ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      setOperatorEmail(session?.user.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const worker = data?.worker;
  const health = worker
    ? {
        label: isWorkerHealthy(worker)
          ? `Worker ${worker.state}`
          : `Worker ${worker.state} · attention`,
        tone: (isWorkerHealthy(worker) ? "ok" : "bad") as "ok" | "bad",
      }
    : null;

  const openWeather = () => {
    setWeatherOpen(true);
    setTab("strategies");
  };

  return (
    <Shell
      tab={tab}
      onTabChange={(next) => {
        if (next !== "strategies") setWeatherOpen(false);
        setTab(next);
      }}
      health={health}
      operatorEmail={operatorEmail}
      onSignOut={async () => {
        await queryClient.cancelQueries();
        await supabase.auth.signOut();
      }}
    >
      {tab === "overview" ? (
        <OverviewView onOpenWeather={openWeather} onOpenActivity={() => setTab("activity")} />
      ) : null}
      {tab === "strategies" ? <StrategiesView initialWeatherOpen={weatherOpen} /> : null}
      {tab === "activity" ? <ActivityView /> : null}
      {tab === "research" ? <ResearchView /> : null}
      {tab === "system" ? <SystemView /> : null}
      <footer className="mt-6 border-t border-border/70 pt-4 text-[11px] text-muted-foreground">
        PAPER SIMULATION ONLY. Every number labelled paper/simulated is derived from public data and
        involves no real funds. Sources: data-api.polymarket.com (trades), clob.polymarket.com (order
        book marks).
      </footer>
    </Shell>
  );
}
