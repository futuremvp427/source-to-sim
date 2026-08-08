import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { EmptyState, Panel, RowSkeleton } from "@/components/mirror/panels";
import { formatUsd } from "@/lib/mirror-trader";
import { getComparison, getSelfCheck } from "@/lib/ops.functions";

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

export function ComparisonSection() {
  const fetchComparison = useServerFn(getComparison);
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["shadow-comparison"],
    queryFn: () => fetchComparison(),
    refetchInterval: 30_000,
  });

  return (
    <Panel
      title="Parallel shadow experiments — fair comparison"
      subtitle="PAPER SIMULATION / DERIVED. Every wallet runs on its own $380 simulated bankroll with isolated cash, positions and P&L. No live orders are ever placed."
    >
      {isPending ? (
        <RowSkeleton rows={5} />
      ) : isError ? (
        <EmptyState message={`Could not load comparison: ${error instanceof Error ? error.message : "unknown error"}`} />
      ) : (data?.rows.length ?? 0) === 0 ? (
        <EmptyState message="No enabled experiments yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pr-3">Experiment</th>
                <th className="py-2 pr-3">Equity</th>
                <th className="py-2 pr-3">Total P&L</th>
                <th className="py-2 pr-3">ROI</th>
                <th className="py-2 pr-3">Realized</th>
                <th className="py-2 pr-3">Cash</th>
                <th className="py-2 pr-3">Open</th>
                <th className="py-2 pr-3">Win / loss</th>
                <th className="py-2 pr-3">Max DD</th>
                <th className="py-2 pr-3">Settled</th>
                <th className="py-2 pr-3">Latency</th>
                <th className="py-2 pr-3">Worker</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="py-2 pr-3">
                    <p className="font-medium text-card-foreground">
                      {r.label}
                      {r.isReference ? <span className="ml-1 text-[10px] text-muted-foreground">REFERENCE</span> : null}
                    </p>
                    <p className="break-all text-[10px] text-muted-foreground">{r.wallet}</p>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{usd(r.equity)}</td>
                  <td className={`py-2 pr-3 tabular-nums ${tone(r.totalPnl)}`}>{usd(r.totalPnl)}</td>
                  <td className={`py-2 pr-3 tabular-nums ${tone(r.roiPct)}`}>{pct(r.roiPct)}</td>
                  <td className={`py-2 pr-3 tabular-nums ${tone(r.realizedPnl)}`}>{formatUsd(r.realizedPnl)}</td>
                  <td className="py-2 pr-3 tabular-nums">{formatUsd(r.cash)}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {r.openPositions}
                    {r.openPositions > 0 && r.markedPositions < r.openPositions ? (
                      <span className="text-[10px] text-muted-foreground"> ({r.markedPositions} marked)</span>
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
                      {r.workerState ?? "—"}
                    </span>
                    <span className="text-[10px] text-muted-foreground"> · lag {ago(r.lagSeconds)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Equity = simulated cash + marked open positions. Median latency is the source-timestamp → paper-decision
            delay from the event validation log. Win/loss counts only paper trades that realized P&L.
          </p>
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
