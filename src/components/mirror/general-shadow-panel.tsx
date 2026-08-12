import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { EmptyState, Panel, RowSkeleton } from "@/components/mirror/panels";
import { formatUsd } from "@/lib/mirror-trader";
import type { ProfitStatus } from "@/lib/general-shadow";
import type { GeneralWalletView } from "@/lib/general-shadow.server";
import { getGeneralShadow } from "@/lib/general-shadow.functions";

function usd(v: number | null): string {
  return v === null ? "Unavailable" : formatUsd(v);
}

function pct(v: number | null): string {
  return v === null ? "Unavailable" : `${v.toFixed(1)}%`;
}

function statusTone(status: ProfitStatus): string {
  if (status === "GREEN") return "text-[var(--gain)]";
  if (status === "RED") return "text-[var(--loss)]";
  return "text-muted-foreground";
}

function Field({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular-nums ${tone ?? "text-card-foreground"}`}>{value}</dd>
    </div>
  );
}

function WalletBlock({ view }: { view: GeneralWalletView }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-card-foreground">{view.handle}</p>
          <p className="break-all font-mono text-[10px] text-muted-foreground">{view.wallet}</p>
        </div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {view.qualification} · worker {view.worker.state} · observed {view.daysObserved}d
        </p>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
        <Field label="Research bankroll" value={`${formatUsd(view.startingCash)} (${formatUsd(view.reserveUsd)} reserve)`} />
        <Field label="Paper cash" value={formatUsd(view.cash)} />
        <Field
          label="Realized P&L"
          value={formatUsd(view.pnl.realized)}
          tone={view.pnl.realized >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"}
        />
        <Field label="Total P&L" value={usd(view.pnl.total)} />
        <Field label="Open cost basis" value={formatUsd(view.positions.openCostBasis)} />
        <Field label="Open positions" value={`${view.positions.open} (${view.positions.conditionExposure} conditions)`} />
        <Field label="Mark coverage" value={pct(view.positions.markCoveragePct)} />
        <Field label="Equity" value={usd(view.pnl.equity)} />
        <Field
          label="Source events (post go-live)"
          value={`${view.sourceEvents.postGoLive} / ${view.sourceEvents.total}`}
        />
        <Field label="Pre-go-live (history only)" value={String(view.sourceEvents.preGoLiveHistoryOnly)} />
        <Field label="Paper BUY / SELL" value={`${view.paper.buys} / ${view.paper.sells}`} />
        <Field label="Cash-starved skips" value={`${view.paper.cashStarvedSkips} (${pct(view.paper.cashStarvedSkipRate)})`} />
        <Field label="Settled outcomes" value={String(view.settlements)} />
        <Field label="Max drawdown" value={usd(view.pnl.maxDrawdown)} />
        <Field label="Copyability completeness" value={pct(view.copyability.completenessPct)} />
        <Field
          label="Median slippage"
          value={view.copyability.medianSlippageCents === null ? "Unavailable" : `${view.copyability.medianSlippageCents.toFixed(2)}¢`}
        />
        <Field label="Fillability" value={pct(view.copyability.fillabilityPct)} />
        <Field
          label="Detect / decide latency"
          value={`${view.latency.detectionSeconds ?? "—"}s / ${view.latency.decisionSeconds ?? "—"}s`}
        />
      </dl>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {view.periods.map((p) => (
          <span key={p.period} className="text-muted-foreground">
            {p.period}{" "}
            <span className={statusTone(p.status)}>
              {p.status}
              {p.pnl === null ? "" : ` ${formatUsd(p.pnl)}`}
            </span>
          </span>
        ))}
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        Category mix (analysis only):{" "}
        {view.categories.length === 0
          ? "none observed yet"
          : view.categories.map((c) => `${c.category} ${c.events}`).join(" · ")}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Non-trade activity (economics UNKNOWN_UNRESOLVED, never copied):{" "}
        {Object.keys(view.activity.byType).length === 0
          ? "none observed"
          : Object.entries(view.activity.byType)
              .map(([type, count]) => `${type} ${count}`)
              .join(" · ")}
      </p>

      <div className="mt-3 overflow-auto">
        <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Daily realized results (UTC)
        </p>
        {view.daily.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No settled day yet.</p>
        ) : (
          <table className="w-full text-left text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Date</th>
                <th className="py-1 pr-2 text-right font-medium">Realized</th>
                <th className="py-1 pr-2 text-right font-medium">Closed</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 text-right font-medium">Cumulative</th>
              </tr>
            </thead>
            <tbody>
              {view.daily.map((d) => (
                <tr key={d.date} className="border-t border-border">
                  <td className="py-1 pr-2 whitespace-nowrap">{d.date}</td>
                  <td className={`py-1 pr-2 text-right tabular-nums ${statusTone(d.status)}`}>
                    {formatUsd(d.realizedPnl)}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">{d.settlements}</td>
                  <td className={`py-1 pr-2 ${statusTone(d.status)}`}>{d.status}</td>
                  <td className="py-1 text-right tabular-nums">{formatUsd(d.cumulativePnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * GENERAL SHADOW — two general-market wallets observed on independent paper
 * ledgers. Never mixed with Weather V2/V3, Poligarch milestones or each other.
 */
export function GeneralShadowSection() {
  const fetchData = useServerFn(getGeneralShadow);
  const { data, isPending, isError } = useQuery({
    queryKey: ["general-shadow"],
    queryFn: () => fetchData(),
    refetchInterval: 60_000,
  });

  return (
    <div className="mb-6">
      <Panel
        title="GENERAL SHADOW — general-market observation (PAPER SIMULATION)"
        subtitle={
          data
            ? `Go-live ${data.goLiveIso} · pre-go-live activity is history only · MONITORING, no live execution`
            : "Independent observation cohort — separate ledgers, separate accounting"
        }
      >
        {isPending ? (
          <RowSkeleton />
        ) : isError || !data ? (
          <EmptyState message="Could not load the General Shadow read model." />
        ) : data.wallets.length === 0 ? (
          <EmptyState message="No General Shadow wallets registered yet." />
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {data.wallets.map((w) => (
              <WalletBlock key={w.experimentId} view={w} />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}