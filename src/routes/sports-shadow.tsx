/**
 * FINAL BUILD Part 28: Sports Shadow read-only operator dashboard.
 *
 * Deliberately a SEPARATE, clearly-labeled page/route rather than a new tab bolted
 * onto the existing "/" MirrorWeather Shadow Bot dashboard's Shell -- that shell (see
 * components/mirror/shell.tsx) is purpose-built and branded for a different,
 * unrelated experiment. This route is still "inside the existing SourceToSim app"
 * (same repo, same deployment) per Part 28's own instruction, just its own area.
 *
 * No trading controls anywhere on this page -- read-only research/operations only.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSportsShadowDashboard } from "@/lib/sports-shadow.functions";

export const Route = createFileRoute("/sports-shadow")({
  head: () => ({
    meta: [
      { title: "Sports Forward Shadow — Research Dashboard" },
      { name: "description", content: "Read-only research/operations view. Paper simulation only — no live orders, no funds." },
    ],
  }),
  component: SportsShadowDashboard,
});

function StageBadge({ stage }: { stage: string }) {
  const tone = stage === "FAILED" ? "destructive" : stage === "LIVE_PILOT_REVIEW_READY" ? "default" : "secondary";
  return <Badge variant={tone}>{stage}</Badge>;
}

function CapabilityRow({ label, capability }: { label: string; capability: { discoveryAvailable: boolean; orderbookAvailable: boolean; checkedAtIso: string } | null }) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 py-2 text-sm last:border-0">
      <span className="font-medium">{label}</span>
      {capability ? (
        <span className="flex items-center gap-2">
          <Badge variant={capability.discoveryAvailable ? "secondary" : "destructive"}>discovery {capability.discoveryAvailable ? "OK" : "DOWN"}</Badge>
          <Badge variant={capability.orderbookAvailable ? "secondary" : "destructive"}>orderbook {capability.orderbookAvailable ? "OK" : "DOWN"}</Badge>
        </span>
      ) : (
        <Badge variant="outline">not yet checked</Badge>
      )}
    </div>
  );
}

function SportsShadowDashboard() {
  const fetchDashboard = useServerFn(getSportsShadowDashboard);
  const { data, isLoading, error } = useQuery({
    queryKey: ["sports-shadow-dashboard"],
    queryFn: () => fetchDashboard(),
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-3 py-6 sm:px-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Sports Forward Shadow</h1>
        <p className="text-sm text-muted-foreground">
          Read-only research dashboard. Paper simulation only — no live orders, no funds, no trading controls on this page.
        </p>
      </header>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <p className="text-sm text-destructive">Failed to load dashboard: {error instanceof Error ? error.message : "unknown error"}</p> : null}

      {data ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                Experiment
                {data.epoch ? <StageBadge stage={data.epoch.stage} /> : <Badge variant="outline">no epoch yet</Badge>}
              </CardTitle>
              <CardDescription>Current stage, epoch, and versioning.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {data.epoch ? (
                <>
                  <div>Go-live: {new Date(data.epoch.goLiveAtIso).toLocaleString()}</div>
                  <div>Wallet cohort: {data.epoch.walletCohort.length} wallet(s)</div>
                  <div className="truncate">Git SHA: {data.epoch.gitSha}</div>
                  <div className="truncate">Config hash: {data.epoch.configHash.slice(0, 16)}…</div>
                </>
              ) : (
                <div className="text-muted-foreground">No experiment epoch has been created yet.</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Milestone Progress</CardTitle>
              <CardDescription>Independent (clustered) settled episodes — never raw fill count.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div>Raw episodes (last 500): {data.milestones.rawEpisodeCount}</div>
              <div>Independent clusters: {data.milestones.independentEpisodeCount}</div>
              <div className="font-medium">Independent settled: {data.milestones.settledIndependentCount}</div>
              <div className="text-muted-foreground">
                Next milestone: {data.milestones.nextMilestone === "100_INDEPENDENT_SETTLED" ? "100 independent settled" : data.milestones.nextMilestone === "300_INDEPENDENT_SETTLED" ? "300 independent settled" : "none — review-ready"}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Venue Capability</CardTitle>
              <CardDescription>Live-probed, credential-free discovery/orderbook access.</CardDescription>
            </CardHeader>
            <CardContent>
              <CapabilityRow label="Polymarket US" capability={data.pmusCapability} />
              <CapabilityRow label="Kalshi" capability={data.kalshiCapability} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Health</CardTitle>
              <CardDescription>Integrity audit and unresolved alerts.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div>
                Last integrity audit:{" "}
                {data.integrity.lastRunIso ? (
                  <Badge variant={data.integrity.passed ? "secondary" : "destructive"}>{data.integrity.passed ? "PASSED" : "FAILED"}</Badge>
                ) : (
                  <span className="text-muted-foreground">never run</span>
                )}
              </div>
              {data.integrity.checksFailed > 0 ? <div className="text-destructive">{data.integrity.checksFailed} check(s) failing</div> : null}
              <div>Unresolved alerts: {data.unresolvedAlertCount}</div>
            </CardContent>
          </Card>

          <Card className="sm:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Wallets</CardTitle>
              <CardDescription>Most recently active tracked wallets (bounded to last 500 signals).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {data.wallets.length === 0 ? (
                <div className="text-muted-foreground">No source activity recorded yet.</div>
              ) : (
                data.wallets.map((w) => (
                  <div key={w.wallet} className="flex items-center justify-between border-b border-border/50 py-1 last:border-0">
                    <span className="truncate font-mono text-xs">{w.wallet}</span>
                    <span className="text-muted-foreground">
                      {w.episodeCount} episode(s){w.lastActivityIso ? ` · last ${new Date(w.lastActivityIso).toLocaleDateString()}` : ""}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <footer className="border-t border-border/70 pt-4 text-[11px] text-muted-foreground">
        PAPER SIMULATION ONLY. No live orders, no trading credentials, no funds. Every number on this page is derived
        from public PM-US/Kalshi/Polymarket data and internal paper-execution simulation.
      </footer>
    </div>
  );
}
