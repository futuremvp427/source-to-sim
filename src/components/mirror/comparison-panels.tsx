import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { EmptyState, Panel, RowSkeleton } from "@/components/mirror/panels";
import { formatUsd } from "@/lib/mirror-trader";
import { getComparison, getSelfCheck, getV2Status } from "@/lib/ops.functions";
import type { ComparisonRow } from "@/lib/comparison.server";

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
