/** Strategies screen: category cards -> Weather detail -> wallet detail. */
import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { formatUsd } from "@/lib/mirror-trader";
import { getComparison } from "@/lib/ops.functions";
import {
  categoryCards,
  categoryWallets,
  formatMoneyOrUnavailable,
  formatPctOrUnavailable,
  markCoverageView,
  pnlTone,
  shortWallet,
  walletBadge,
  workerBadge,
} from "@/lib/ui/portfolio-view";
import { DASHBOARD_REFRESH_MS, useMasterPortfolio } from "@/lib/ui/use-dashboard-queries";
import type { MasterWallet } from "@/lib/master-portfolio";

import { CapacityComparisonSection, ComparisonSection } from "./comparison-panels";
import { Chip, Metric, PaperLabel, TerminalCard, WalletGlyph, toneClass } from "./terminal";

export function StrategiesView({ initialWeatherOpen = false }: { initialWeatherOpen?: boolean }) {
  const [weatherOpen, setWeatherOpen] = useState(initialWeatherOpen);
  const [walletId, setWalletId] = useState<string | null>(null);
  const { data: portfolio, isPending } = useMasterPortfolio();
  const wallets = categoryWallets(portfolio, "WEATHER");
  const selected = wallets.find((w) => w.experimentId === walletId) ?? null;

  if (selected) {
    return <WalletDetail wallet={selected} onBack={() => setWalletId(null)} />;
  }

  if (weatherOpen) {
    const category = portfolio?.categories.find((c) => c.key === "WEATHER") ?? null;
    const coverage = markCoverageView(category);
    return (
      <div className="space-y-3">
        <BackButton label="All strategies" onClick={() => setWeatherOpen(false)} />
        <TerminalCard
          title="Weather sleeve"
          subtitle="Five V2 fair-comparison paper wallets — the only sleeve in master totals"
          action={<PaperLabel />}
        >
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Metric label="Starting capital" value={formatMoneyOrUnavailable(category?.startingCapital)} />
            <Metric label="Cash" value={formatMoneyOrUnavailable(category?.cash)} />
            <Metric
              label="Realized P&L"
              value={formatMoneyOrUnavailable(category?.realizedPnl)}
              tone={pnlTone(category?.realizedPnl)}
            />
            <Metric
              label="Capital in positions"
              value={formatMoneyOrUnavailable(category?.openCostBasis)}
            />
            <Metric label="Open positions" value={category ? String(category.openPositions) : "…"} />
            <Metric label="Mark coverage" value={coverage.pctLabel} hint={coverage.label} />
            <Metric
              label="Equity"
              value={formatMoneyOrUnavailable(category?.equity)}
              hint={category?.equity == null ? "Pending complete marks" : undefined}
            />
            <Metric
              label="Total P&L / ROI"
              value={
                category?.totalPnl == null
                  ? formatMoneyOrUnavailable(null)
                  : `${formatUsd(category.totalPnl)} · ${formatPctOrUnavailable(category.roiPct)}`
              }
              tone={pnlTone(category?.totalPnl)}
            />
          </div>
        </TerminalCard>

        <TerminalCard
          title="Wallet contributions"
          subtitle="Realized P&L descending · V3 capacity wallets are comparison-only and excluded"
        >
          {isPending ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted/60" />
              ))}
            </div>
          ) : (
            <ul className="space-y-2">
              {wallets.map((w) => {
                const badge = workerBadge(w);
                const cov = markCoverageView(w);
                return (
                  <li key={w.experimentId}>
                    <button
                      type="button"
                      onClick={() => setWalletId(w.experimentId)}
                      className="w-full rounded-md border border-border/70 bg-background/40 px-3 py-2 text-left transition-colors hover:border-[var(--paper)]/60 hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-center gap-3">
                        <WalletGlyph badge={walletBadge(w.label)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {w.label}
                            </span>
                            <span className={`text-sm tabular-nums ${toneClass(pnlTone(w.realizedPnl))}`}>
                              {formatUsd(w.realizedPnl)}
                            </span>
                          </div>
                          <p className="truncate font-mono text-[10px] text-muted-foreground">
                            {shortWallet(w.wallet)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-4">
                        <span>Cash <strong className="tabular-nums text-foreground">{formatUsd(w.cash)}</strong></span>
                        <span>In positions <strong className="tabular-nums text-foreground">{formatUsd(w.openCostBasis)}</strong></span>
                        <span>Open <strong className="tabular-nums text-foreground">{w.openPositions}</strong></span>
                        <span>Marks <strong className="tabular-nums text-foreground">{cov.label}</strong></span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Chip tone={badge.tone}>Worker {badge.label}</Chip>
                        <Chip tone={w.equity == null ? "warn" : "muted"}>
                          Equity {formatMoneyOrUnavailable(w.equity)}
                        </Chip>
                        <Chip tone="muted">ROI {formatPctOrUnavailable(w.roiPct)}</Chip>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </TerminalCard>
      </div>
    );
  }

  const cards = categoryCards(portfolio);
  return (
    <div className="space-y-3">
      <TerminalCard title="Strategy categories" subtitle="Master allocation by sleeve">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map((card) => {
            const active = card.status === "ACTIVE";
            const body = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold tracking-[0.1em] text-foreground">
                    {card.label}
                  </span>
                  <Chip tone={active ? "ok" : "muted"}>{active ? "Active" : "Research"}</Chip>
                </div>
                <p className="mt-2 text-lg font-semibold tabular-nums text-foreground">
                  {active && card.totals ? formatUsd(card.totals.realizedPnl) : "Not allocated"}
                </p>
                <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {active ? "Realized P&L" : "No master allocation"}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">{card.note}</p>
              </>
            );
            return active ? (
              <button
                key={card.key}
                type="button"
                onClick={() => setWeatherOpen(true)}
                className="rounded-md border border-border/70 bg-background/40 px-3 py-2 text-left transition-colors hover:border-[var(--paper)]/60 hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </button>
            ) : (
              <div
                key={card.key}
                className="rounded-md border border-border/50 bg-background/20 px-3 py-2 opacity-80"
              >
                {body}
              </div>
            );
          })}
        </div>
      </TerminalCard>
    </div>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded border border-border/70 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronLeft className="size-3" aria-hidden /> {label}
    </button>
  );
}

function WalletDetail({ wallet, onBack }: { wallet: MasterWallet; onBack: () => void }) {
  const [advanced, setAdvanced] = useState(false);
  const fetchComparison = useServerFn(getComparison);
  const { data } = useQuery({
    queryKey: ["comparison"],
    queryFn: () => fetchComparison(),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
  const row = data?.v2Rows.find((r) => r.id === wallet.experimentId) ?? null;
  const coverage = markCoverageView(wallet);
  const badge = workerBadge(wallet);

  return (
    <div className="space-y-3">
      <BackButton label="Weather sleeve" onClick={onBack} />
      <TerminalCard
        title={`${wallet.label} — paper wallet`}
        subtitle={wallet.wallet}
        action={<Chip tone={badge.tone}>Worker {badge.label}</Chip>}
      >
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Metric label="Starting capital" value={formatUsd(wallet.startingCapital)} />
          <Metric label="Cash" value={formatUsd(wallet.cash)} />
          <Metric
            label="Realized P&L"
            value={formatUsd(wallet.realizedPnl)}
            tone={pnlTone(wallet.realizedPnl)}
          />
          <Metric label="Capital in positions" value={formatUsd(wallet.openCostBasis)} />
          <Metric label="Open positions" value={String(wallet.openPositions)} />
          <Metric label="Mark coverage" value={coverage.pctLabel} hint={coverage.label} />
          <Metric
            label="Equity"
            value={formatMoneyOrUnavailable(wallet.equity)}
            hint={wallet.equity == null ? "Pending complete marks" : undefined}
          />
          <Metric
            label="Total P&L / ROI"
            value={
              wallet.totalPnl == null
                ? formatMoneyOrUnavailable(null)
                : `${formatUsd(wallet.totalPnl)} · ${formatPctOrUnavailable(wallet.roiPct)}`
            }
            tone={pnlTone(wallet.totalPnl)}
          />
        </div>
      </TerminalCard>

      <TerminalCard title="Measured behaviour" subtitle="From the bounded fair-comparison reader">
        {!row ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading measurements…</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Metric label="Buys / sells" value={`${row.buys} / ${row.sells}`} size="sm" />
            <Metric
              label="Settled markets"
              value={String(row.settledCount)}
              hint={`${row.wins}W / ${row.losses}L`}
              size="sm"
            />
            <Metric
              label="Win rate"
              value={row.winRatePct === null ? "Unavailable" : `${row.winRatePct.toFixed(1)}%`}
              size="sm"
            />
            <Metric label="Max drawdown" value={formatUsd(row.maxDrawdown)} size="sm" />
            <Metric
              label="Skips"
              value={`${row.skippedCount}`}
              hint={
                row.skipRatePct === null ? "rate unavailable" : `${row.skipRatePct.toFixed(1)}% of decisions`
              }
              size="sm"
            />
            <Metric
              label="Median total latency"
              value={
                row.medianLatencySeconds === null ? "Unavailable" : `${row.medianLatencySeconds}s`
              }
              size="sm"
            />
            <Metric
              label="Next buy size"
              value={row.nextBuyUsd === null ? "Unavailable" : formatUsd(row.nextBuyUsd)}
              hint={row.sizingRule}
              size="sm"
            />
            <Metric
              label="Spendable cash"
              value={formatUsd(row.spendableCash)}
              hint={`reserve ${formatUsd(row.reservedCash)}`}
              size="sm"
            />
          </div>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          Per-wallet trade tape is not exposed by a bounded per-wallet reader yet; the full paper feed
          lives under Activity.
        </p>
      </TerminalCard>

      <TerminalCard
        title="Advanced"
        subtitle="V2 vs V3 capacity comparison, copyability and latency diagnostics"
        action={
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="rounded border border-border/70 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {advanced ? "Hide" : "Show"}
          </button>
        }
      >
        {advanced ? (
          <div className="space-y-3">
            <p className="text-[11px] text-muted-foreground">
              V3 CAPACITY is comparison-only and never contributes to Master Portfolio totals.
            </p>
            <ComparisonSection />
            <CapacityComparisonSection />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Diagnostics are collapsed to keep the wallet view readable.
          </p>
        )}
      </TerminalCard>
    </div>
  );
}