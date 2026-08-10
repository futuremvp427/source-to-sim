import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { EmptyState, Panel, RowSkeleton } from "@/components/mirror/panels";
import { formatUsd } from "@/lib/mirror-trader";
import { getCapacityComparison, getComparison, getSelfCheck, getV2Status } from "@/lib/ops.functions";
import type { ComparisonRow } from "@/lib/comparison.server";
import type { CapacityRow } from "@/lib/capacity-core";

function usd(v: number | null): string {
  return v === null ? "Unavailable" : formatUsd(v);
}

function pct(v: number | null, digits = 2): string {
  return v === null ? "Unavailable" : `${v.toFixed(digits)}%`;
}

function tone(v: number | null): string {
  if (v === null) return "text-muted-foreground";
  return v >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]";
}

function ago(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function tsLabel(iso: string | null): string {
  return iso === null ? "Unavailable" : new Date(iso).toLocaleString();
}

function roiPct(v: number | null): string {
  return v === null ? "Unavailable" : `${(v * 100).toFixed(2)}%`;
}

function CapacityRowCells({ row, cohort }: { row: CapacityRow | null; cohort: "V2" | "V3" }) {
  if (!row) {
    return (
      <tr className="border-t border-border">
        <td className="py-2 pr-3 text-[11px] uppercase text-muted-foreground">{cohort}</td>
        <td className="py-2 pr-3 text-[11px] text-muted-foreground" colSpan={10}>
          No enabled {cohort} experiment for this wallet.
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-t border-border">
      <td className="py-2 pr-3">
        <span className="text-[11px] font-semibold uppercase text-card-foreground">{row.cohort}</span>
        <span className="block text-[10px] text-muted-foreground">{row.name}</span>
      </td>
      <td className="py-2 pr-3 tabular-nums">{formatUsd(row.startingBankroll)}</td>
      <td className="py-2 pr-3 tabular-nums">{formatUsd(row.cash)}</td>
      <td className="py-2 pr-3 tabular-nums">{formatUsd(row.reserve)}</td>
      <td className="py-2 pr-3 tabular-nums">{formatUsd(row.spendable)}</td>
      <td className="py-2 pr-3 tabular-nums">{formatUsd(row.openCostBasis)}</td>
      <td className={`py-2 pr-3 tabular-nums ${tone(row.realizedPnl)}`}>{formatUsd(row.realizedPnl)}</td>
      <td className={`py-2 pr-3 tabular-nums ${tone(row.roi)}`}>{roiPct(row.roi)}</td>
      <td className="py-2 pr-3 tabular-nums">
        {row.buys}/{row.sells}
      </td>
      <td className="py-2 pr-3 tabular-nums">{row.insufficientCashSkips}</td>
      <td className="py-2 pr-3 tabular-nums">{formatUsd(row.maxDrawdownCash)}</td>
      <td className="py-2 pr-3 tabular-nums">{row.settledMarkets}</td>
    </tr>
  );
}

export function CapacityComparisonSection() {
  const fetchCapacity = useServerFn(getCapacityComparison);
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["capacity-comparison"],
    queryFn: () => fetchCapacity(),
    refetchInterval: 30_000,
  });

  return (
    <Panel
      title="V2 vs V3 capacity comparison"
      subtitle="PAPER SIMULATION / DERIVED. Same five wallets, same dynamic-v1 sizing — only the simulated bankroll differs ($380 V2 vs $1,000 V3). Read-only: no live orders, no new instrumentation."
    >
      {isPending ? (
        <RowSkeleton rows={5} />
      ) : isError ? (
        <EmptyState
          message={`Could not load capacity comparison: ${error instanceof Error ? error.message : "unknown error"}`}
        />
      ) : (data?.groups.length ?? 0) === 0 ? (
        <EmptyState message="No enabled V2 or V3 experiments yet." />
      ) : (
        <div className="space-y-4">
          {(data?.groups ?? []).map((group) => (
            <div key={group.handle} className="rounded-md border border-border p-3">
              <p className="text-xs font-medium text-card-foreground">{group.handle}</p>
              <p className="break-all text-[10px] text-muted-foreground">{group.wallet}</p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[900px] text-xs">
                  <thead className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Cohort</th>
                      <th className="py-2 pr-3">Bankroll</th>
                      <th className="py-2 pr-3">Cash</th>
                      <th className="py-2 pr-3">Reserve</th>
                      <th className="py-2 pr-3">Spendable</th>
                      <th className="py-2 pr-3">Open cost basis</th>
                      <th className="py-2 pr-3">Realized P&L</th>
                      <th className="py-2 pr-3">ROI</th>
                      <th className="py-2 pr-3">Copied B/S</th>
                      <th className="py-2 pr-3">Cash-reserve skips</th>
                      <th className="py-2 pr-3">Max DD (cash)</th>
                      <th className="py-2 pr-3">Settled</th>
                    </tr>
                  </thead>
                  <tbody>
                    <CapacityRowCells row={group.v2} cohort="V2" />
                    <CapacityRowCells row={group.v3} cohort="V3" />
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">{data?.note}</p>
        </div>
      )}
    </Panel>
  );
}

function CohortTable({ rows }: { rows: ComparisonRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1180px] text-xs">
        <thead className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-2 pr-3">Experiment</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Start</th>
            <th className="py-2 pr-3">Equity</th>
            <th className="py-2 pr-3">Total P&L</th>
            <th className="py-2 pr-3">ROI</th>
            <th className="py-2 pr-3">Realized</th>
            <th className="py-2 pr-3">Unrealized</th>
            <th className="py-2 pr-3">Cash</th>
            <th className="py-2 pr-3">Reserved</th>
            <th className="py-2 pr-3">Spendable</th>
            <th className="py-2 pr-3">Sizing rule</th>
            <th className="py-2 pr-3">Open</th>
            <th className="py-2 pr-3">Copied B/S</th>
            <th className="py-2 pr-3">Skipped</th>
            <th className="py-2 pr-3">Win / loss</th>
            <th className="py-2 pr-3">Max DD</th>
            <th className="py-2 pr-3">Settled</th>
            <th className="py-2 pr-3">Latency</th>
            <th className="py-2 pr-3">Worker</th>
            <th className="py-2 pr-3">Last poll OK</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border align-top">
              <td className="py-2 pr-3">
                <p className="font-medium text-card-foreground">
                  {r.label}
                  {r.isReference ? (
                    <span className="ml-1 text-[10px] text-muted-foreground">REFERENCE</span>
                  ) : null}
                </p>
                <p className="break-all text-[10px] text-muted-foreground">{r.wallet}</p>
              </td>
              <td className="py-2 pr-3">
                <span className={r.enabled ? "text-[var(--gain)]" : "text-muted-foreground"}>
                  {r.cohort === "V2" ? (r.enabled ? "V2 RUNNING" : "V2 PAUSED") : "V1 FROZEN"}
                </span>
              </td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.startingCash)}</td>
              <td className="py-2 pr-3 tabular-nums">{usd(r.equity)}</td>
              <td className={`py-2 pr-3 tabular-nums ${tone(r.totalPnl)}`}>{usd(r.totalPnl)}</td>
              <td className={`py-2 pr-3 tabular-nums ${tone(r.roiPct)}`}>{pct(r.roiPct)}</td>
              <td className={`py-2 pr-3 tabular-nums ${tone(r.realizedPnl)}`}>{formatUsd(r.realizedPnl)}</td>
              <td className={`py-2 pr-3 tabular-nums ${tone(r.unrealizedPnl)}`}>{usd(r.unrealizedPnl)}</td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.cash)}</td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.reservedCash)}</td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.spendableCash)}</td>
              <td className="py-2 pr-3 text-[11px] text-muted-foreground">{r.sizingRule}</td>
              <td className="py-2 pr-3 tabular-nums">
                {r.openPositions}
                {r.openPositions > 0 && r.markedPositions < r.openPositions ? (
                  <span className="text-[10px] text-muted-foreground"> ({r.markedPositions} marked)</span>
                ) : null}
              </td>
              <td className="py-2 pr-3 tabular-nums">
                {r.buys}/{r.sells}
              </td>
              <td className="py-2 pr-3">
                <span className="tabular-nums">{r.skippedCount}</span>
                {r.skipReasons.length > 0 ? (
                  <span className="block text-[10px] text-muted-foreground">
                    {r.skipReasons.map((s) => `${s.reason} ×${s.count}`).join(", ")}
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-3 tabular-nums">
                {r.wins}/{r.losses}{" "}
                <span className="text-[10px] text-muted-foreground">{pct(r.winRatePct, 1)}</span>
              </td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.maxDrawdown)}</td>
              <td className="py-2 pr-3 tabular-nums">{r.settledCount}</td>
              <td className="py-2 pr-3 tabular-nums">
                {r.medianLatencySeconds === null ? "Unavailable" : `${r.medianLatencySeconds}s`}
              </td>
              <td className="py-2 pr-3">
                <span className={r.lastError ? "text-[var(--loss)]" : "text-muted-foreground"}>
                  {r.workerState ?? "Unavailable"}
                </span>
                <span className="text-[10px] text-muted-foreground"> · lag {ago(r.lagSeconds)}</span>
              </td>
              <td className="py-2 pr-3 text-[10px] text-muted-foreground">{tsLabel(r.lastSuccessAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function V2StatusSection() {
  const fetchStatus = useServerFn(getV2Status);
  const { data, isPending, isError } = useQuery({
    queryKey: ["v2-status"],
    queryFn: () => fetchStatus(),
    refetchInterval: 30_000,
  });

  const headline = !data ? "V2 FAIR COMPARISON" : data.running ? "V2 FAIR COMPARISON — RUNNING" : "V2 FAIR COMPARISON — INCOMPLETE";

  return (
    <Panel
      title={headline}
      subtitle="PAPER SIMULATION / DERIVED. Autonomous: paper copying never requires manual approval."
      action={
        data ? (
          <span className={`text-xs font-semibold uppercase ${data.running ? "text-[var(--gain)]" : "text-amber-600"}`}>
            {data.enabledCount}/{data.expectedCount} enabled
          </span>
        ) : null
      }
    >
      {isPending ? (
        <RowSkeleton rows={3} />
      ) : isError || !data ? (
        <EmptyState message="Could not load the V2 status block." />
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-[10px] uppercase text-muted-foreground">V2 go-live</dt>
              <dd className="text-card-foreground">{tsLabel(data.goLiveAt)}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase text-muted-foreground">Newest successful poll</dt>
              <dd className="text-card-foreground">{tsLabel(data.newestSuccessAt)}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase text-muted-foreground">New V2 source events</dt>
              <dd className="tabular-nums text-card-foreground">
                {data.newV2SourceEvents === null ? "Unavailable" : data.newV2SourceEvents}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase text-muted-foreground">V2 simulated trades</dt>
              <dd className="tabular-nums text-card-foreground">{data.v2PaperTrades}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase text-muted-foreground">Poll failures</dt>
              <dd className="tabular-nums text-card-foreground">{data.pollFailures}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase text-muted-foreground">Workers healthy</dt>
              <dd className={data.allWorkersHealthy ? "text-[var(--gain)]" : "text-amber-600"}>
                {data.allWorkersHealthy ? "All five healthy" : "Attention needed"}
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted-foreground">{data.note}</p>
        </div>
      )}
    </Panel>
  );
}

export function ComparisonSection() {
  const fetchComparison = useServerFn(getComparison);
  const [showV1, setShowV1] = useState(false);
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["shadow-comparison"],
    queryFn: () => fetchComparison(),
    refetchInterval: 30_000,
  });

  return (
    <Panel
      title="Parallel shadow experiments — V2 fair comparison"
      subtitle="PAPER SIMULATION / DERIVED. Each V2 wallet starts from an identical $380 simulated bankroll with isolated cash, positions and P&L. Paper copying is fully autonomous — no manual approval. No live orders are ever placed."
    >
      {isPending ? (
        <RowSkeleton rows={5} />
      ) : isError ? (
        <EmptyState message={`Could not load comparison: ${error instanceof Error ? error.message : "unknown error"}`} />
      ) : (data?.v2Rows.length ?? 0) === 0 ? (
        <EmptyState message="No V2 experiments yet." />
      ) : (
        <div className="space-y-4">
          <CohortTable rows={data?.v2Rows ?? []} />
          <p className="text-[11px] text-muted-foreground">
            Paper BUY sizing: min($5, 1% of available paper cash), floor $1, with a 10% starting-bankroll cash
            reserve ($38) that new BUYs may never breach (skipped as INSUFFICIENT_CASH_RESERVE). Equity = simulated
            cash + marked open positions; it reads Unavailable when a fresh public mark is missing. Median latency is
            the source-timestamp → paper-decision delay from the event validation log.
          </p>
          {(data?.v1Rows.length ?? 0) > 0 ? (
            <div className="border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setShowV1((v) => !v)}
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground underline"
              >
                {showV1 ? "Hide" : "Show"} V1 history ({data?.v1Rows.length}) — frozen, not part of the fair comparison
              </button>
              {showV1 ? (
                <div className="mt-3 space-y-2">
                  <p className="text-[11px] text-muted-foreground">
                    V1 experiments ran under unequal conditions before dynamic-v1 sizing. They are retained for audit
                    and disabled from future copying.
                  </p>
                  <CohortTable rows={data?.v1Rows ?? []} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

const STATUS_TONE: Record<string, string> = {
  PASS: "text-[var(--gain)]",
  WARN: "text-amber-600",
  FAIL: "text-[var(--loss)]",
};

function cents(v: number | null | undefined): string {
  return v === null || v === undefined ? "Unavailable" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}¢`;
}

function sourceTsLabel(ts: number | null): string {
  return ts === null ? "Unavailable" : new Date(ts * 1000).toLocaleString();
}

function EvidenceTable({ rows }: { rows: ComparisonRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1400px] text-xs">
        <thead className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-2 pr-3">Wallet</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Post-V2 events</th>
            <th className="py-2 pr-3">Decisions</th>
            <th className="py-2 pr-3">Paper B/S</th>
            <th className="py-2 pr-3">Total trades</th>
            <th className="py-2 pr-3">Skipped / rate</th>
            <th className="py-2 pr-3">Top skip reasons</th>
            <th className="py-2 pr-3">Avg BUY</th>
            <th className="py-2 pr-3">Avg SELL</th>
            <th className="py-2 pr-3">Start</th>
            <th className="py-2 pr-3">Cash</th>
            <th className="py-2 pr-3">Reserve</th>
            <th className="py-2 pr-3">Spendable</th>
            <th className="py-2 pr-3">Est. BUYs left</th>
            <th className="py-2 pr-3">Realized</th>
            <th className="py-2 pr-3">Unrealized</th>
            <th className="py-2 pr-3">Total P&L</th>
            <th className="py-2 pr-3">ROI</th>
            <th className="py-2 pr-3">Open</th>
            <th className="py-2 pr-3">Settled</th>
            <th className="py-2 pr-3">Win / loss</th>
            <th className="py-2 pr-3">Max DD</th>
            <th className="py-2 pr-3">Detection lat.</th>
            <th className="py-2 pr-3">Decision lat.</th>
            <th className="py-2 pr-3">Slip now</th>
            <th className="py-2 pr-3">Slip +30s</th>
            <th className="py-2 pr-3">Slip +60s</th>
            <th className="py-2 pr-3">Copyability</th>
            <th className="py-2 pr-3">Completeness</th>
            <th className="py-2 pr-3">Last source fill</th>
            <th className="py-2 pr-3">Last poll OK</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border align-top">
              <td className="py-2 pr-3">
                <p className="font-medium text-card-foreground">{r.label}</p>
                <p className="break-all text-[10px] text-muted-foreground">{r.wallet}</p>
              </td>
              <td className="py-2 pr-3">
                <span className={r.enabled ? "text-[var(--gain)]" : "text-muted-foreground"}>
                  {r.enabled ? "V2 RUNNING" : "V2 PAUSED"}
                </span>
              </td>
              <td className="py-2 pr-3 tabular-nums">
                {r.postGoLiveSourceEvents === null ? "Unavailable" : r.postGoLiveSourceEvents}
              </td>
              <td className="py-2 pr-3 tabular-nums">{r.eligibleDecisions}</td>
              <td className="py-2 pr-3 tabular-nums">
                {r.buys}/{r.sells}
              </td>
              <td className="py-2 pr-3 tabular-nums">{r.totalPaperTrades}</td>
              <td className="py-2 pr-3 tabular-nums">
                {r.skippedCount} <span className="text-[10px] text-muted-foreground">{pct(r.skipRatePct, 1)}</span>
              </td>
              <td className="py-2 pr-3 text-[10px] text-muted-foreground">
                {r.skipReasons.length === 0 ? "—" : r.skipReasons.map((s) => `${s.reason} ×${s.count}`).join(", ")}
              </td>
              <td className="py-2 pr-3 tabular-nums">{usd(r.avgBuyUsd)}</td>
              <td className="py-2 pr-3 tabular-nums">{usd(r.avgSellUsd)}</td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.startingCash)}</td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.cash)}</td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.reservedCash)}</td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.spendableCash)}</td>
              <td className="py-2 pr-3 tabular-nums">
                {r.estimatedRemainingBuys}
                {r.nextBuyUsd === null ? (
                  <span className="block text-[10px] text-muted-foreground">reserve reached</span>
                ) : (
                  <span className="block text-[10px] text-muted-foreground">next {formatUsd(r.nextBuyUsd)}</span>
                )}
              </td>
              <td className={`py-2 pr-3 tabular-nums ${tone(r.realizedPnl)}`}>{formatUsd(r.realizedPnl)}</td>
              <td className={`py-2 pr-3 tabular-nums ${tone(r.unrealizedPnl)}`}>{usd(r.unrealizedPnl)}</td>
              <td className={`py-2 pr-3 tabular-nums ${tone(r.totalPnl)}`}>{usd(r.totalPnl)}</td>
              <td className={`py-2 pr-3 tabular-nums ${tone(r.roiPct)}`}>{pct(r.roiPct)}</td>
              <td className="py-2 pr-3 tabular-nums">{r.openPositions}</td>
              <td className="py-2 pr-3 tabular-nums">{r.settledCount}</td>
              <td className="py-2 pr-3 tabular-nums">
                {r.wins}/{r.losses}
              </td>
              <td className="py-2 pr-3 tabular-nums">{formatUsd(r.maxDrawdown)}</td>
              <td className="py-2 pr-3 tabular-nums">
                {r.medianDetectionLatencySeconds === null ? "Unavailable" : `${r.medianDetectionLatencySeconds}s`}
              </td>
              <td className="py-2 pr-3 tabular-nums">
                {r.medianDecisionLatencySeconds === null ? "Unavailable" : `${r.medianDecisionLatencySeconds}s`}
              </td>
              <td className="py-2 pr-3 tabular-nums">{cents(r.copyability.medianSlippageCentsByDelay.immediate)}</td>
              <td className="py-2 pr-3 tabular-nums">{cents(r.copyability.medianSlippageCentsByDelay["30s"])}</td>
              <td className="py-2 pr-3 tabular-nums">{cents(r.copyability.medianSlippageCentsByDelay["60s"])}</td>
              <td className="py-2 pr-3">
                {r.copyability.status === "SCORED" ? (
                  <span className="font-semibold tabular-nums text-card-foreground">{r.copyability.score}</span>
                ) : (
                  <span className="text-[10px] uppercase text-amber-600">Insufficient data</span>
                )}
                <span className="block text-[10px] text-muted-foreground">
                  {r.copyability.observedSamples}/{r.copyability.expectedSamples} samples
                </span>
              </td>
              <td className="py-2 pr-3 tabular-nums">{(r.copyability.completeness * 100).toFixed(1)}%</td>
              <td className="py-2 pr-3 text-[10px] text-muted-foreground">{sourceTsLabel(r.lastSourceActivityTs)}</td>
              <td className="py-2 pr-3 text-[10px] text-muted-foreground">{tsLabel(r.lastSuccessAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EvidenceSection() {
  const fetchComparison = useServerFn(getComparison);
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["shadow-comparison"],
    queryFn: () => fetchComparison(),
    refetchInterval: 30_000,
  });

  return (
    <Panel
      title="V2 copyability evidence"
      subtitle="Measurement only. Slippage is measured against the real public order book at detection and again at +30s, +60s, +5m and +15m: a follower BUY pays the observable ask, a follower SELL receives the observable bid. Samples that could not be observed stay blank and are never counted as zero."
    >
      {isPending ? (
        <RowSkeleton rows={5} />
      ) : isError ? (
        <EmptyState message={`Could not load evidence: ${error instanceof Error ? error.message : "unknown error"}`} />
      ) : (data?.v2Rows.length ?? 0) === 0 ? (
        <EmptyState message="No V2 experiments yet." />
      ) : (
        <div className="space-y-3">
          <EvidenceTable rows={data?.v2Rows ?? []} />
          <p className="text-[11px] text-muted-foreground">
            Copyability score = 50% slippage (delay-weighted) + 20% top-of-book spread + 30% estimated fillability from
            visible depth. A wallet needs at least three post-go-live events with usable observations and 30% sample
            completeness, otherwise it reports INSUFFICIENT DATA instead of a number. Estimated BUYs left replays
            dynamic-v1 sizing against spendable cash and is an estimate only — no bankroll is ever refilled or reset.
          </p>
        </div>
      )}
    </Panel>
  );
}

export function SelfCheckSection() {
  const fetchCheck = useServerFn(getSelfCheck);
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["shadow-selfcheck"],
    queryFn: () => fetchCheck(),
    refetchInterval: 60_000,
  });

  return (
    <Panel
      title="System health / self-check"
      subtitle="Read-only diagnostics for the database, scheduled polling, worker leases, ingestion and public APIs."
      action={
        data ? (
          <span className={`text-xs font-semibold uppercase ${STATUS_TONE[data.overall] ?? ""}`}>{data.overall}</span>
        ) : null
      }
    >
      {isPending ? (
        <RowSkeleton rows={4} />
      ) : isError ? (
        <EmptyState message={`Self-check failed: ${error instanceof Error ? error.message : "unknown error"}`} />
      ) : (
        <ul className="space-y-2 text-xs">
          {data?.checks.map((c) => (
            <li key={c.id} className="flex flex-wrap items-baseline gap-2 border-b border-border pb-2 last:border-0">
              <span className={`w-12 font-semibold uppercase ${STATUS_TONE[c.status] ?? ""}`}>{c.status}</span>
              <span className="font-medium text-card-foreground">{c.label}</span>
              <span className="text-muted-foreground">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
