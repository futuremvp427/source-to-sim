/** Overview screen: master paper portfolio, sleeves, contributions, recent feed. */
import { ArrowUpRight, LineChart, Trophy } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { formatTime, formatUsd } from "@/lib/mirror-trader";
import {
  categoryCards,
  equityHeroView,
  formatMoneyOrUnavailable,
  formatPctOrUnavailable,
  markCoverageView,
  pnlTone,
  realizedContributions,
  shortWallet,
  walletBadge,
} from "@/lib/ui/portfolio-view";
import { useMasterPortfolio, useShadowDashboard, useSportsShadowDashboard } from "@/lib/ui/use-dashboard-queries";

import {
  Chip,
  MagnitudeBar,
  Metric,
  PaperLabel,
  TerminalCard,
  WalletGlyph,
  toneClass,
} from "./terminal";

const RECENT_LIMIT = 8;

export function OverviewView({
  onOpenWeather,
  onOpenActivity,
}: {
  onOpenWeather: () => void;
  onOpenActivity: () => void;
}) {
  const { data: portfolio, isPending, isError, error } = useMasterPortfolio();
  const master = portfolio?.master;
  const hero = equityHeroView(portfolio);
  const coverage = markCoverageView(master ?? null);
  const cards = categoryCards(portfolio);
  const contributions = realizedContributions(portfolio);

  return (
    <div className="space-y-3">
      {isError ? (
        <TerminalCard>
          <p className="text-sm text-[var(--loss)]">
            Master portfolio unavailable: {error instanceof Error ? error.message : "unknown error"}
          </p>
        </TerminalCard>
      ) : null}

      <SportsShadowCard />

      <TerminalCard

        title="Master paper portfolio"
        subtitle={
          portfolio
            ? `Derived rollup · generated ${new Date(portfolio.generatedAt).toLocaleTimeString("en-US")}`
            : "Loading derived rollup…"
        }
        action={<PaperLabel />}
      >
        <div className="rounded-md border border-border/60 bg-background/40 px-3 py-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {hero.headline}
          </p>
          <p
            className={`mt-1 text-3xl font-semibold tabular-nums sm:text-4xl ${
              hero.trusted ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {isPending ? "…" : hero.value}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Chip tone={hero.trusted ? "ok" : "warn"}>Marks {coverage.label}</Chip>
            <span className="text-[11px] text-muted-foreground">
              Realized P&amp;L{" "}
              <strong className={`tabular-nums ${toneClass(hero.realizedTone)}`}>
                {hero.realizedLabel}
              </strong>
            </span>
            {portfolio?.reconciliation.ok === false ? (
              <Chip tone="bad">Reconciliation mismatch</Chip>
            ) : null}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Metric label="Starting capital" value={formatMoneyOrUnavailable(master?.startingCapital)} />
          <Metric label="Cash available" value={formatMoneyOrUnavailable(master?.cash)} />
          <Metric
            label="Realized P&L"
            value={hero.realizedLabel}
            tone={hero.realizedTone}
            hint="Exact — closed paper lifecycles"
          />
          <Metric
            label="Capital in positions"
            value={formatMoneyOrUnavailable(master?.openCostBasis)}
            hint={master ? `${master.openPositions} open position(s)` : undefined}
          />
          <Metric label="Open positions" value={master ? String(master.openPositions) : "…"} />
          <Metric
            label="Mark coverage"
            value={coverage.pctLabel}
            hint={coverage.label}
            tone={coverage.complete ? "default" : "muted"}
          />
          <Metric
            label="Unrealized P&L"
            value={formatMoneyOrUnavailable(master?.unrealizedPnl)}
            tone={pnlTone(master?.unrealizedPnl ?? null)}
            hint={master?.unrealizedPnl == null ? "Pending complete marks" : undefined}
          />
          <Metric
            label="Total P&L / ROI"
            value={
              master?.totalPnl == null
                ? formatMoneyOrUnavailable(null)
                : `${formatUsd(master.totalPnl)} · ${formatPctOrUnavailable(master.roiPct)}`
            }
            tone={pnlTone(master?.totalPnl ?? null)}
            hint={master?.totalPnl == null ? "Pending complete marks" : undefined}
          />
        </div>
      </TerminalCard>

      <TerminalCard title="Portfolio performance" subtitle="Equity history">
        <div className="flex min-h-[9rem] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 bg-background/30 px-4 py-8 text-center">
          <LineChart className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium text-foreground">No reconciled equity series yet</p>
          <p className="max-w-md text-[11px] text-muted-foreground">
            Portfolio equity history will appear once a reconciled, bounded series is available. No
            curve is drawn from partial marks.
          </p>
        </div>
      </TerminalCard>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <TerminalCard title="Strategy categories" subtitle="Only Weather is allocated today">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {cards.map((card) => {
              const active = card.status === "ACTIVE";
              const content = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold tracking-[0.1em] text-foreground">
                      {card.label}
                    </span>
                    <Chip tone={active ? "ok" : "muted"}>{active ? "Active" : "Research"}</Chip>
                  </div>
                  {active && card.totals ? (
                    <dl className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                      <div className="flex justify-between gap-2">
                        <dt>Realized P&amp;L</dt>
                        <dd className={`tabular-nums ${toneClass(pnlTone(card.totals.realizedPnl))}`}>
                          {formatUsd(card.totals.realizedPnl)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt>Cash</dt>
                        <dd className="tabular-nums text-foreground">
                          {formatUsd(card.totals.cash)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt>Equity</dt>
                        <dd className="tabular-nums">
                          {formatMoneyOrUnavailable(card.totals.equity)}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-2 text-[11px] text-muted-foreground">Not allocated</p>
                  )}
                  <p className="mt-2 text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
                    {card.note}
                  </p>
                </>
              );
              return active ? (
                <button
                  key={card.key}
                  type="button"
                  onClick={onOpenWeather}
                  className="rounded-md border border-border/70 bg-background/40 px-3 py-2 text-left transition-colors hover:border-[var(--paper)]/60 hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {content}
                </button>
              ) : (
                <div
                  key={card.key}
                  className="rounded-md border border-border/50 bg-background/20 px-3 py-2 opacity-80"
                >
                  {content}
                </div>
              );
            })}
          </div>
        </TerminalCard>

        <TerminalCard
          title="Top wallet contributions"
          subtitle="Metric: realized P&L (total return unavailable while marks are incomplete)"
        >
          {contributions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No included wallets loaded yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {contributions.map((c) => (
                <li key={c.experimentId} className="flex items-center gap-3">
                  <WalletGlyph badge={walletBadge(c.label)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-foreground">{c.label}</span>
                      <span className={`text-xs tabular-nums ${toneClass(c.tone)}`}>
                        {formatUsd(c.realizedPnl)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <MagnitudeBar pct={c.barPct} tone={c.tone} />
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {shortWallet(c.wallet)}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TerminalCard>
      </div>

      <RecentActivityCard onOpenActivity={onOpenActivity} />
    </div>
  );
}

function RecentActivityCard({ onOpenActivity }: { onOpenActivity: () => void }) {
  const { data, isPending } = useShadowDashboard();
  const rows = (data?.paperTrades ?? []).slice(0, RECENT_LIMIT);

  return (
    <TerminalCard
      title="Recent activity"
      subtitle={`Newest ${RECENT_LIMIT} paper decisions`}
      action={
        <button
          type="button"
          onClick={onOpenActivity}
          className="inline-flex items-center gap-1 rounded border border-border/70 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          View all <ArrowUpRight className="size-3" aria-hidden />
        </button>
      }
    >
      {isPending ? (
        <div className="space-y-2 py-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-muted/60" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No paper decisions yet.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {rows.map((t) => (
            <li key={t.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2">
              <Chip tone={t.action === "BUY" ? "ok" : t.action === "SELL" ? "bad" : "muted"}>
                {t.action}
              </Chip>
              <div className="min-w-0">
                <p className="truncate text-xs text-foreground">{t.marketTitle}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {t.sourceTs ? formatTime(t.sourceTs) : "—"}
                  {t.reason ? ` · ${t.reason}` : ""}
                </p>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-foreground">
                {formatUsd(t.notional)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </TerminalCard>
  );
}