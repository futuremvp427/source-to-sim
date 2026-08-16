import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { EmptyState, Panel, RowSkeleton } from "@/components/mirror/panels";
import { getCandidateShadowPanel } from "@/lib/candidates.functions";
import { formatUsd } from "@/lib/mirror-trader";

function time(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("en-US") : "—";
}

function candidateStart(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString("en-US") : "—";
}

function tradePrice(price: number | null): string {
  return price === null ? "—" : `${(price * 100).toFixed(1)}¢`;
}

export function ActiveCandidatePaperSection() {
  const fetchPanel = useServerFn(getCandidateShadowPanel);
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["candidate-shadow-panel"],
    queryFn: () => fetchPanel(),
    refetchInterval: 15_000,
  });

  return (
    <Panel
      title="Active Candidate Paper Followers"
      subtitle="PAPER ONLY · separate from the 10-bot V2/V3 clean cohort. These cards show the actual CANDIDATE: experiments, worker health, bankroll, open exposure, and persisted paper BUY/SELL/SKIP decisions."
    >
      {isPending ? (
        <RowSkeleton rows={3} />
      ) : isError ? (
        <EmptyState
          message={`Could not load active candidate followers: ${error instanceof Error ? error.message : "unknown error"}`}
        />
      ) : !data?.followers.length ? (
        <EmptyState message="No active CANDIDATE: paper experiments are present." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-3">
          {data.followers.map((candidate) => {
            const workerHealthy =
              candidate.worker.heartbeatAgeSeconds !== null &&
              candidate.worker.heartbeatAgeSeconds < 300 &&
              candidate.worker.state !== "error" &&
              candidate.worker.state !== "stale";
            return (
              <article key={candidate.id} className="rounded-lg border border-border p-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-card-foreground">{candidate.name.replace(/^CANDIDATE:\s*/, "")}</p>
                    <p className="mt-0.5 break-all text-[10px] text-muted-foreground">{candidate.wallet}</p>
                  </div>
                  <span className={workerHealthy ? "text-[var(--gain)]" : "text-[var(--loss)]"}>
                    {candidate.worker.state}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
                  <Cell label="Cash" value={formatUsd(candidate.cash)} />
                  <Cell label="Realized P&L" value={formatUsd(candidate.realizedPnl)} />
                  <Cell label="Open positions" value={String(candidate.openPositions)} />
                  <Cell label="Open cost basis" value={formatUsd(candidate.openCostBasis)} />
                  <Cell label="Events seen" value={candidate.checkpoint.eventsSeen.toLocaleString("en-US")} />
                  <Cell label="Poll failures" value={String(candidate.worker.pollFailures)} />
                  <Cell label="Candidate start" value={candidateStart(candidate.followFromTs)} />
                  <Cell label="Last success" value={time(candidate.worker.lastSuccessAt)} />
                </dl>

                <p className="mt-2 text-[10px] text-muted-foreground">
                  {candidate.sizingRule} · starting cash {formatUsd(candidate.startingCash)} · category-agnostic · bootstrap {candidate.checkpoint.bootstrapComplete ? "complete" : "pending"}
                </p>
                {candidate.worker.lastError ? (
                  <p className="mt-2 text-[10px] text-[var(--loss)]">Last error: {candidate.worker.lastError}</p>
                ) : null}

                <div className="mt-3 border-t border-border pt-2">
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Recent actual paper decisions
                  </p>
                  {candidate.recentTrades.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No post-start paper BUY/SELL/SKIP decisions yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {candidate.recentTrades.slice(0, 6).map((trade) => (
                        <li key={trade.id} className="rounded border border-border/70 px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={
                                trade.action === "BUY"
                                  ? "font-semibold text-[var(--gain)]"
                                  : trade.action === "SELL"
                                    ? "font-semibold"
                                    : "text-muted-foreground"
                              }
                            >
                              {trade.action}
                            </span>
                            <span className="tabular-nums text-muted-foreground">
                              {trade.action === "SKIP" ? trade.reason ?? "skipped" : `${formatUsd(trade.notional)} @ ${tradePrice(trade.price)}`}
                            </span>
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[10px] text-foreground/80">
                            {trade.marketTitle}{trade.outcome ? ` · ${trade.outcome}` : ""}
                          </p>
                          <p className="mt-0.5 text-[10px] text-muted-foreground">{time(trade.createdAt)}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground/90">{value}</dd>
    </div>
  );
}
