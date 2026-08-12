import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { EmptyState, Panel, RowSkeleton } from "@/components/mirror/panels";
import { formatUsd } from "@/lib/mirror-trader";
import type { MilestoneStatus, ObservationSeries } from "@/lib/observation/daily.server";
import { getObservationLog } from "@/lib/ops.functions";

function usd(v: number | null): string {
  return v === null ? "Unavailable" : formatUsd(v);
}

function pct(v: number | null): string {
  return v === null ? "Unavailable" : `${v.toFixed(1)}%`;
}

function tone(v: number | null): string {
  if (v === null) return "text-muted-foreground";
  return v >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]";
}

const MILESTONE_LABEL: Record<MilestoneStatus, string> = {
  reached: "REACHED",
  not_reached: "NOT REACHED",
  unavailable: "UNAVAILABLE",
};

function milestoneTone(status: MilestoneStatus): string {
  if (status === "reached") return "text-[var(--gain)]";
  if (status === "unavailable") return "text-muted-foreground";
  return "text-card-foreground";
}

function SeriesBlock({ series }: { series: ObservationSeries }) {
  const recent = series.days.slice(-14);
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-card-foreground">{series.name}</p>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Worker {series.worker.status} — {series.worker.reason}
        </p>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Settled days</dt>
          <dd className="tabular-nums text-card-foreground">{series.settledDays}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Settlements</dt>
          <dd className="tabular-nums text-card-foreground">{series.settlements}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Realized P&L</dt>
          <dd className={`tabular-nums ${tone(series.realizedPnl)}`}>{formatUsd(series.realizedPnl)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            Est. slippage-adjusted ({series.observedSlippageCents === null ? "—" : `${series.observedSlippageCents}¢`})
          </dt>
          <dd className={`tabular-nums ${tone(series.slippageAdjustedCumulativePnl)}`}>
            {usd(series.slippageAdjustedCumulativePnl)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cash-starved skip rate</dt>
          <dd className="tabular-nums text-card-foreground">
            {pct(series.cashSkipRatePct)}
            <span className="text-muted-foreground"> ({series.cashStarvedSkips}/{series.buyAttempts})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Fillability</dt>
          <dd className="tabular-nums text-card-foreground">{pct(series.fillabilityPct)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Copyability completeness</dt>
          <dd className="tabular-nums text-card-foreground">{pct(series.copyabilityCompletenessPct)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Mark coverage</dt>
          <dd className="tabular-nums text-card-foreground">
            {series.markCoveragePct === null
              ? "0 / 0 — N/A"
              : `${series.freshlyMarkedPositions} / ${series.openPositions} (${series.markCoveragePct.toFixed(0)}%)`}
          </dd>
        </div>
      </dl>

      <ul className="mt-3 space-y-1">
        {series.milestones.map((m) => (
          <li key={m.key} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
            <span className={`font-semibold uppercase ${milestoneTone(m.status)}`}>
              {MILESTONE_LABEL[m.status]}
            </span>
            <span className="text-card-foreground">{m.label}</span>
            <span className="text-muted-foreground">
              {m.target} · observed {m.observed}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-2 pr-3">Settled day</th>
              <th className="py-2 pr-3">Settlements</th>
              <th className="py-2 pr-3">Realized P&L</th>
              <th className="py-2 pr-3">Cumulative</th>
              <th className="py-2 pr-3">Est. adj. P&L</th>
              <th className="py-2 pr-3">Est. adj. cumulative</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr className="border-t border-border">
                <td className="py-2 text-[11px] text-muted-foreground" colSpan={6}>
                  No settled days recorded yet.
                </td>
              </tr>
            ) : (
              recent.map((d) => (
                <tr key={d.day} className="border-t border-border">
                  <td className="py-2 pr-3 tabular-nums">{d.day}</td>
                  <td className="py-2 pr-3 tabular-nums">{d.settlements}</td>
                  <td className={`py-2 pr-3 tabular-nums ${tone(d.realizedPnl)}`}>{formatUsd(d.realizedPnl)}</td>
                  <td className={`py-2 pr-3 tabular-nums ${tone(d.cumulativeRealizedPnl)}`}>
                    {formatUsd(d.cumulativeRealizedPnl)}
                  </td>
                  <td className={`py-2 pr-3 tabular-nums ${tone(d.slippageAdjustedPnl)}`}>
                    {usd(d.slippageAdjustedPnl)}
                  </td>
                  <td className={`py-2 pr-3 tabular-nums ${tone(d.cumulativeSlippageAdjustedPnl)}`}>
                    {usd(d.cumulativeSlippageAdjustedPnl)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ObservationLogSection() {
  const fetchLog = useServerFn(getObservationLog);
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["observation-log"],
    queryFn: () => fetchLog(),
    refetchInterval: 60_000,
  });

  return (
    <Panel
      title="Out-of-sample observation log"
      subtitle="PAPER SIMULATION / DERIVED. Daily statistics preserved while V2 and V3 keep running unchanged. Milestones are research flags only — they do not qualify or promote a wallet, and live allocation stays $0."
    >
      {isPending ? (
        <RowSkeleton rows={4} />
      ) : isError ? (
        <EmptyState
          message={`Could not load the observation log: ${error instanceof Error ? error.message : "unknown error"}`}
        />
      ) : (data?.series.length ?? 0) === 0 ? (
        <EmptyState message="No enabled observation cohort yet." />
      ) : (
        <div className="space-y-4">
          {(data?.series ?? []).map((series) => (
            <SeriesBlock key={series.experimentId} series={series} />
          ))}
          <p className="text-[11px] text-muted-foreground">{data?.note}</p>
        </div>
      )}
    </Panel>
  );
}
