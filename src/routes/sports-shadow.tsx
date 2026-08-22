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
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "lucide-react";

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

/**
 * CODEX P2-4: a query FAILURE must never render identically to a genuine "nothing here
 * yet" empty state -- see dashboard.server.ts's DashboardDegradedFlags. This badge is the
 * one place that distinction is surfaced to an operator.
 */
function DegradedBadge() {
  return <Badge variant="destructive">data unavailable</Badge>;
}

function CapabilityRow({ label, capability, degraded }: { label: string; capability: { discoveryAvailable: boolean; orderbookAvailable: boolean; checkedAtIso: string } | null; degraded: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 py-2 text-sm last:border-0">
      <span className="font-medium">{label}</span>
      {degraded ? (
        <DegradedBadge />
      ) : capability ? (
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

function usd(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function ClassificationBadge({ label }: { label: string }) {
  const tone = label === "LIVE_PILOT_REVIEW_READY" ? "default" : label === "KILL" ? "destructive" : label === "CANDIDATE_FOR_OOS" || label === "INTERESTING" ? "secondary" : "outline";
  return <Badge variant={tone}>{label}</Badge>;
}

function ResultsSection({ results }: { results: NonNullable<import("@/lib/sports-shadow/dashboard.server").DashboardResults> }) {
  const { fullEpoch, calibration, oos } = results;
  const core = fullEpoch.analytics.core;
  const risk = fullEpoch.analytics.risk;

  return (
    <>
      <Card className="sm:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Results — Whole Epoch (declared strategy: ${fullEpoch.notionalTierUsd})</CardTitle>
          <CardDescription>Every number below is paper-simulated. No live orders, no funds.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
          <div>Raw episodes: {core.rawEpisodeCount} · Independent: {core.independentEpisodeCount}</div>
          <div>Settled: {core.settledCount} ({core.wins}W / {core.losses}L / {core.pushes}P)</div>
          <div>Net P&amp;L: <span className="font-medium">{usd(core.netPnlUsd)}</span> (gross {usd(core.grossPnlUsd)}, fees {usd(core.feesUsd)})</div>
          <div>ROI: {pct(core.roi)}</div>
          <div>Expectancy / independent episode: {usd(core.expectancyPerIndependentEpisode)}</div>
          <div>Bootstrap 90% CI: [{usd(fullEpoch.bootstrap.lowerUsd)}, {usd(fullEpoch.bootstrap.upperUsd)}] (P(positive) = {pct(fullEpoch.bootstrap.probabilityPositive)})</div>
          <div>Baseline ({fullEpoch.baseline.version}): {usd(fullEpoch.baseline.baselineExpectancyPerEpisodeUsd)}/episode — edge {usd(fullEpoch.baseline.edgeUsd)}</div>
          <div>Max drawdown: {usd(risk.maxDrawdownUsd)} (peak {usd(risk.peakEquityUsd)}, {risk.equityCurve.length} settled points)</div>
          <div>Largest win / loss: {usd(risk.largestWinUsd)} / {usd(risk.largestLossUsd)} (concentration {pct(risk.profitConcentration)})</div>
        </CardContent>
      </Card>

      <Card className="sm:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Robustness</CardTitle>
          <CardDescription>The headline result above is never a retroactively selected subgroup — these are stress tests applied on top of it.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
          <div>Top 5 wins removed: {usd(fullEpoch.robustness.top5WinsRemoved.remaining.netPnlUsd)} (removed {usd(fullEpoch.robustness.top5WinsRemoved.removedNetPnlUsd)})</div>
          <div>Largest win removed: {usd(fullEpoch.robustness.largestWinRemoved.remaining.netPnlUsd)}</div>
          <div>Largest loss removed: {usd(fullEpoch.robustness.largestLossRemoved.remaining.netPnlUsd)}</div>
          <div>+1¢ adverse stress: {usd(fullEpoch.robustness.oneCentAdverseStress.netPnlUsd)}</div>
          <div>+2¢ adverse stress: {usd(fullEpoch.robustness.twoCentAdverseStress.netPnlUsd)}</div>
          <div>First half / second half: {usd(fullEpoch.robustness.firstHalfSecondHalf.firstHalf.netPnlUsd)} / {usd(fullEpoch.robustness.firstHalfSecondHalf.secondHalf.netPnlUsd)}</div>
          <div>Wallet concentration (HHI): {fullEpoch.robustness.walletConcentration.herfindahlIndex.toFixed(2)} ({fullEpoch.robustness.walletConcentration.walletCount} wallets, top {pct(fullEpoch.robustness.walletConcentration.topWalletShareOfNetPnl)})</div>
          <div className="sm:col-span-2">
            Size-tier capacity: {fullEpoch.robustness.sizeTierCapacity.map((t) => `$${t.key}: ${usd(t.metrics.netPnlUsd)}`).join(" · ")}
          </div>
        </CardContent>
      </Card>

      <Card className="sm:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Execution &amp; Breakdowns</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
          <div>Match rate: {pct(fullEpoch.analytics.execution.matchRate)} · Reject: {pct(fullEpoch.analytics.execution.rejectRate)} · Liquidity failure: {pct(fullEpoch.analytics.execution.liquidityFailureRate)}</div>
          <div>Avg spread: {fullEpoch.analytics.execution.averageSpread?.toFixed(4) ?? "n/a"} · Avg slippage: {fullEpoch.analytics.execution.averageSlippageCents?.toFixed(2) ?? "n/a"}¢</div>
          <div className="sm:col-span-2">By venue: {fullEpoch.analytics.breakdowns.byChosenVenue.map((b) => `${b.key}: ${usd(b.metrics.netPnlUsd)}`).join(" · ") || "n/a"}</div>
          <div className="sm:col-span-2">By bet type: {fullEpoch.analytics.breakdowns.byBetType.map((b) => `${b.key}: ${usd(b.metrics.netPnlUsd)}`).join(" · ") || "n/a"}</div>
          <div className="sm:col-span-2">By wallet: {fullEpoch.analytics.breakdowns.byWallet.map((b) => `${b.key.slice(0, 8)}…: ${usd(b.metrics.netPnlUsd)}`).join(" · ") || "n/a"}</div>
        </CardContent>
      </Card>

      {calibration ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              Calibration <ClassificationBadge label={calibration.classification} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>Independent settled: {calibration.report.analytics.core.independentSettledCount}</div>
            <div>Net P&amp;L: {usd(calibration.report.analytics.core.netPnlUsd)} · Expectancy: {usd(calibration.report.analytics.core.expectancyPerIndependentEpisode)}</div>
            <div>P(positive): {pct(calibration.report.bootstrap.probabilityPositive)}</div>
          </CardContent>
        </Card>
      ) : null}

      {oos ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              Out-of-Sample <ClassificationBadge label={oos.classification} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>Independent settled: {oos.report.analytics.core.independentSettledCount}</div>
            <div>Net P&amp;L: {usd(oos.report.analytics.core.netPnlUsd)} · Expectancy: {usd(oos.report.analytics.core.expectancyPerIndependentEpisode)}</div>
            <div>P(positive): {pct(oos.report.bootstrap.probabilityPositive)}</div>
            {oos.gate.ready ? (
              <div className="font-medium text-foreground">LIVE_PILOT_REVIEW_READY — research classification only, no trading is enabled by this label.</div>
            ) : (
              <div>
                <div className="font-medium">Blocked from LIVE_PILOT_REVIEW_READY:</div>
                <ul className="list-inside list-disc text-muted-foreground">
                  {oos.gate.blockedReasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </>
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
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-3" aria-hidden />
          Back to Mirror dashboard
        </Link>
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
                {data.degraded.epoch ? <DegradedBadge /> : data.epoch ? <StageBadge stage={data.epoch.stage} /> : <Badge variant="outline">no epoch yet</Badge>}
              </CardTitle>
              <CardDescription>Current stage, epoch, and versioning.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {data.degraded.epoch ? (
                <div className="text-destructive">Epoch lookup failed -- this is NOT "no epoch yet," the query itself did not succeed.</div>
              ) : data.epoch ? (
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
              <CardTitle className="flex items-center justify-between text-base">
                Milestone Progress
                {data.degraded.milestones ? <DegradedBadge /> : null}
              </CardTitle>
              <CardDescription>Independent (clustered) settled episodes — never raw fill count.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {data.degraded.milestones ? (
                <div className="text-destructive">Milestone counts unavailable -- do not read the values below as zero/current.</div>
              ) : (
                <>
                  <div>Raw episodes (full epoch): {data.milestones.rawEpisodeCount}</div>
                  <div>Independent clusters: {data.milestones.independentEpisodeCount}</div>
                  <div className="font-medium">Independent settled: {data.milestones.settledIndependentCount}</div>
                  <div className="text-muted-foreground">
                    Next milestone: {data.milestones.nextMilestone === "100_INDEPENDENT_SETTLED" ? "100 independent settled" : data.milestones.nextMilestone === "300_INDEPENDENT_SETTLED" ? "300 independent settled" : "none — review-ready"}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Venue Capability</CardTitle>
              <CardDescription>Live-probed, credential-free discovery/orderbook access.</CardDescription>
            </CardHeader>
            <CardContent>
              <CapabilityRow label="Polymarket US" capability={data.pmusCapability} degraded={data.degraded.capability} />
              <CapabilityRow label="Kalshi" capability={data.kalshiCapability} degraded={data.degraded.capability} />
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
                {data.degraded.integrity ? (
                  <DegradedBadge />
                ) : data.integrity.lastRunIso ? (
                  <Badge variant={data.integrity.passed ? "secondary" : "destructive"}>{data.integrity.passed ? "PASSED" : "FAILED"}</Badge>
                ) : (
                  <span className="text-muted-foreground">never run</span>
                )}
              </div>
              {data.integrity.checksFailed > 0 ? <div className="text-destructive">{data.integrity.checksFailed} check(s) failing</div> : null}
              <div className="flex items-center gap-2">
                Unresolved alerts: {data.degraded.alerts ? <DegradedBadge /> : data.unresolvedAlertCount}
              </div>
            </CardContent>
          </Card>

          <Card className="sm:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                Wallets
                {data.degraded.signals ? <DegradedBadge /> : null}
              </CardTitle>
              <CardDescription>Most recently active tracked wallets (bounded to last 500 signals).</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {data.degraded.signals ? (
                <div className="text-destructive">Wallet activity unavailable -- this is NOT "no source activity," the query itself did not succeed.</div>
              ) : data.wallets.length === 0 ? (
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

          {data.degraded.results ? (
            <Card className="sm:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  Results
                  <DegradedBadge />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-sm text-destructive">Results computation failed -- not "no results yet."</div>
              </CardContent>
            </Card>
          ) : data.results ? (
            <ResultsSection results={data.results} />
          ) : null}
        </div>
      ) : null}

      <footer className="border-t border-border/70 pt-4 text-[11px] text-muted-foreground">
        PAPER SIMULATION ONLY. No live orders, no trading credentials, no funds. Every number on this page is derived
        from public PM-US/Kalshi/Polymarket data and internal paper-execution simulation.
      </footer>
    </div>
  );
}
