import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { EmptyState, Panel, RowSkeleton, SideTag, Stat } from "@/components/mirror/panels";
import { getMirrorSnapshot } from "@/lib/mirror-trader.functions";
import {
  TARGET_WALLET,
  buildPaperBook,
  countWeather,
  derivePaperActions,
  filterTrades,
  formatShares,
  formatTime,
  formatUsd,
  isWeatherMarket,
  type TradeSide,
} from "@/lib/mirror-trader";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mirror Trader MVP — Polymarket wallet monitor & paper simulator" },
      {
        name: "description",
        content:
          "Read-only Polymarket wallet monitor with a deterministic paper copy-trade simulator. No live orders, no credentials.",
      },
      { property: "og:title", content: "Mirror Trader MVP" },
      {
        property: "og:description",
        content:
          "Monitor a Polymarket wallet's public trades and simulate paper copies deterministically. Read-only.",
      },
    ],
  }),
  component: Dashboard,
});

const SIDES: Array<"ALL" | TradeSide> = ["ALL", "BUY", "SELL"];

function Dashboard() {
  const fetchSnapshot = useServerFn(getMirrorSnapshot);
  const [search, setSearch] = useState("");
  const [side, setSide] = useState<"ALL" | TradeSide>("ALL");
  const [paperAmount, setPaperAmount] = useState(10);
  const [weatherOnly, setWeatherOnly] = useState<boolean | null>(null);

  const query = useQuery({
    queryKey: ["mirror-snapshot"],
    queryFn: () => fetchSnapshot(),
    refetchOnWindowFocus: false,
  });

  const snapshot = query.data;

  const weatherCounts = useMemo(
    () => (snapshot ? countWeather(snapshot.trades) : { weather: 0, other: 0 }),
    [snapshot],
  );
  // Default ON when the wallet has weather trades; user choice always wins.
  const weatherFilterOn = weatherOnly ?? weatherCounts.weather > 0;

  const derived = useMemo(() => {
    if (!snapshot) return null;
    const scoped = weatherFilterOn
      ? snapshot.trades.filter((t) => isWeatherMarket(t.title, t.slug))
      : snapshot.trades;
    const visibleTrades = filterTrades(scoped, search, side);
    const actions = derivePaperActions(scoped, paperAmount);
    const visibleActions = derivePaperActions(visibleTrades, paperAmount);
    const book = buildPaperBook(actions, snapshot.positions, snapshot.fetchedAt, snapshot.mode);
    const settledPaper = book.settled.reduce((s, r) => s + r.realized, 0);
    const openWithMark = book.open.filter((p) => p.openPnl !== null);
    const openPaperPnl = openWithMark.reduce((s, p) => s + (p.openPnl ?? 0), 0);
    return {
      visibleTrades,
      visibleActions,
      book,
      settledPaper,
      openPaperPnl,
      openMarkCoverage: `${openWithMark.length}/${book.open.length}`,
      hasFreshMark: openWithMark.length > 0,
    };
  }, [snapshot, search, side, paperAmount, weatherFilterOn]);

  const isDemo = snapshot?.mode === "DEMO";
  const loading = query.isPending;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Mirror Trader MVP</h1>
            <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-semibold text-secondary-foreground">
              READ-ONLY
            </span>
            <span className="rounded-md bg-[var(--paper-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--paper)]">
              PAPER SIMULATION
            </span>
            {snapshot ? (
              <span
                className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                  isDemo
                    ? "bg-[var(--warn-soft)] text-[var(--warn)]"
                    : "bg-[var(--gain-soft)] text-[var(--gain)]"
                }`}
              >
                {isDemo ? "DEMO DATA" : "LIVE DATA"}
              </span>
            ) : null}
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Monitors public Polymarket activity for{" "}
            <code className="break-all rounded bg-muted px-1 py-0.5 text-xs">{TARGET_WALLET}</code>{" "}
            and derives simulated paper copies. No orders are ever placed and no credentials are
            used.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <button
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {query.isFetching ? "Refreshing…" : "Refresh"}
          </button>
          <p className="text-xs text-muted-foreground">
            Last updated:{" "}
            {snapshot ? new Date(snapshot.fetchedAt).toLocaleString("en-US") : "not yet loaded"}
          </p>
        </div>
      </header>

      {query.isError ? (
        <div className="mt-6 rounded-xl border border-[var(--loss)] bg-[var(--loss-soft)] px-4 py-3 text-sm text-[var(--loss)]">
          Could not load the dashboard data. {(query.error as Error).message}{" "}
          <button onClick={() => query.refetch()} className="underline">
            Try again
          </button>
        </div>
      ) : null}

      {isDemo && snapshot?.fallbackReason ? (
        <div className="mt-6 rounded-xl border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3 text-sm text-[var(--warn)]">
          <strong>DEMO / SAMPLE MODE.</strong> {snapshot.fallbackReason}
        </div>
      ) : null}

      {/* Overview */}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Source trades"
          value={loading ? "—" : String(snapshot?.trades.length ?? 0)}
          hint={isDemo ? "Demo sample" : "Public API"}
        />
        <Stat
          label="Paper actions (derived)"
          value={loading ? "—" : String(derived?.visibleActions.length ?? 0)}
          hint="1:1 with visible source trades"
        />
        <Stat
          label="Settled paper P&L"
          value={loading ? "—" : formatUsd(derived?.settledPaper ?? 0)}
          tone={(derived?.settledPaper ?? 0) >= 0 ? "positive" : "negative"}
          hint="Closed simulated positions"
        />
        <Stat
          label="Open paper P&L"
          value={loading ? "—" : derived?.hasFreshMark ? formatUsd(derived.openPaperPnl) : "Unavailable"}
          tone={derived?.hasFreshMark ? ((derived.openPaperPnl ?? 0) >= 0 ? "positive" : "negative") : "muted"}
          hint={
            derived?.hasFreshMark
              ? `Fresh marks for ${derived.openMarkCoverage} positions`
              : "No reliable fresh mark available"
          }
        />
      </div>

      {/* Controls */}
      <div className="mt-6 flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm sm:flex-row sm:items-end">
        <label className="flex-1 text-xs font-medium text-muted-foreground">
          Market search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by market title…"
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <div className="text-xs font-medium text-muted-foreground">
          Side
          <div className="mt-1 flex rounded-md border border-input p-0.5">
            {SIDES.map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  side === s
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <label className="text-xs font-medium text-muted-foreground">
          Paper amount per BUY (USD)
          <input
            type="number"
            min={1}
            step={1}
            value={paperAmount}
            onChange={(e) => setPaperAmount(Math.max(1, Number(e.target.value) || 1))}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm tabular-nums text-foreground outline-none focus:ring-2 focus:ring-ring sm:w-40"
          />
        </label>
        <div className="text-xs font-medium text-muted-foreground">
          Market type
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={() => setWeatherOnly(!weatherFilterOn)}
              aria-pressed={weatherFilterOn}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                weatherFilterOn
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input text-muted-foreground hover:bg-accent"
              }`}
            >
              Weather only
            </button>
            <span className="whitespace-nowrap tabular-nums">
              {weatherCounts.weather} weather / {weatherCounts.other} other
              <span className="ml-1 rounded bg-secondary px-1 py-0.5 text-[10px] font-semibold text-secondary-foreground">
                HEURISTIC
              </span>
            </span>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Weather classification is a transparent title/slug keyword HEURISTIC, not an authoritative
        category. Toggle it off to see every fetched trade — nothing is hidden permanently.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-6">
        {/* Recent source trades */}
        <Panel
          title="Recent source trades"
          subtitle={`Public fills from the monitored wallet${isDemo ? " (DEMO)" : ""}`}
        >
          {loading ? (
            <RowSkeleton />
          ) : !derived?.visibleTrades.length ? (
            <EmptyState message="No source trades match the current filters." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Time</th>
                    <th className="py-2 pr-3 font-medium">Side</th>
                    <th className="py-2 pr-3 font-medium">Market</th>
                    <th className="py-2 pr-3 text-right font-medium">Shares</th>
                    <th className="py-2 pr-3 text-right font-medium">Price</th>
                    <th className="py-2 text-right font-medium">Notional</th>
                  </tr>
                </thead>
                <tbody>
                  {derived.visibleTrades.slice(0, 40).map((t) => (
                    <tr key={t.id} className="border-t border-border align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatTime(t.timestamp)}
                      </td>
                      <td className="py-2 pr-3">
                        <SideTag side={t.side} />
                      </td>
                      <td className="py-2 pr-3">
                        <span className="line-clamp-2">{t.title}</span>
                        <span className="text-xs text-muted-foreground">{t.outcome}</span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatShares(t.size)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{t.price.toFixed(3)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatUsd(t.size * t.price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Paper copy activity */}
        <Panel
          title="Paper copy activity"
          subtitle="PAPER SIMULATION / DERIVED — deterministic, never submitted anywhere"
        >
          {loading ? (
            <RowSkeleton />
          ) : !derived?.visibleActions.length ? (
            <EmptyState message="No paper actions derived for the current filters." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Time</th>
                    <th className="py-2 pr-3 font-medium">Side</th>
                    <th className="py-2 pr-3 font-medium">Market</th>
                    <th className="py-2 pr-3 text-right font-medium">Paper shares</th>
                    <th className="py-2 pr-3 text-right font-medium">Paper notional</th>
                    <th className="py-2 font-medium">Rule applied</th>
                  </tr>
                </thead>
                <tbody>
                  {derived.visibleActions.slice(0, 40).map((a) => (
                    <tr key={a.id} className="border-t border-border align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatTime(a.timestamp)}
                      </td>
                      <td className="py-2 pr-3">
                        <SideTag side={a.side} />
                      </td>
                      <td className="py-2 pr-3">
                        <span className="line-clamp-2">{a.title}</span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatShares(a.shares)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatUsd(a.notional)}</td>
                      <td className="py-2 text-xs text-muted-foreground">{a.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Positions */}
        <Panel
          title="Positions"
          subtitle="Simulated open paper positions, with source marks where fresh"
        >
          {loading ? (
            <RowSkeleton />
          ) : !derived?.book.open.length ? (
            <EmptyState message="No open simulated positions." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Market</th>
                    <th className="py-2 pr-3 text-right font-medium">Paper shares</th>
                    <th className="py-2 pr-3 text-right font-medium">Avg price</th>
                    <th className="py-2 pr-3 text-right font-medium">Cost basis</th>
                    <th className="py-2 pr-3 text-right font-medium">Mark</th>
                    <th className="py-2 text-right font-medium">Open P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {derived.book.open.slice(0, 40).map((p) => (
                    <tr key={p.asset} className="border-t border-border align-top">
                      <td className="py-2 pr-3">
                        <span className="line-clamp-2">{p.title}</span>
                        <span className="text-xs text-muted-foreground">{p.outcome}</span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatShares(p.shares)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{p.avgPrice.toFixed(3)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatUsd(p.costBasis)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {p.mark === null ? (
                          <span className="text-muted-foreground">Unavailable</span>
                        ) : (
                          p.mark.toFixed(3)
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {p.openPnl === null ? (
                          <span className="text-muted-foreground">Unavailable</span>
                        ) : (
                          <span
                            className={
                              p.openPnl >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"
                            }
                          >
                            {formatUsd(p.openPnl)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Settled P&L */}
        <Panel
          title="Settled P&L"
          subtitle="Paper realizations from closed simulated positions, plus the wallet's reported realized P&L"
        >
          {loading ? (
            <RowSkeleton rows={3} />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Stat
                  label="Paper settled total (derived)"
                  value={formatUsd(derived?.settledPaper ?? 0)}
                  tone={(derived?.settledPaper ?? 0) >= 0 ? "positive" : "negative"}
                  hint="Derived from source fills only"
                />
                <Stat
                  label={`Source reported realized P&L${isDemo ? " (DEMO)" : ""}`}
                  value={formatUsd(derived?.sourceRealized ?? 0)}
                  tone={(derived?.sourceRealized ?? 0) >= 0 ? "positive" : "negative"}
                  hint="Reported by the public positions endpoint — not recomputed"
                />
              </div>
              {!derived?.book.settled.length ? (
                <EmptyState message="No settled paper positions yet." />
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3 font-medium">Closed</th>
                        <th className="py-2 pr-3 font-medium">Market</th>
                        <th className="py-2 pr-3 text-right font-medium">Cost basis</th>
                        <th className="py-2 pr-3 text-right font-medium">Proceeds</th>
                        <th className="py-2 text-right font-medium">Realized</th>
                      </tr>
                    </thead>
                    <tbody>
                      {derived.book.settled.slice(0, 25).map((r) => (
                        <tr key={`${r.asset}-${r.closedAt}`} className="border-t border-border">
                          <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground tabular-nums">
                            {formatTime(r.closedAt)}
                          </td>
                          <td className="py-2 pr-3">
                            <span className="line-clamp-2">{r.title}</span>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatUsd(r.costBasis)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {formatUsd(r.proceeds)}
                          </td>
                          <td
                            className={`py-2 text-right tabular-nums ${
                              r.realized >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"
                            }`}
                          >
                            {formatUsd(r.realized)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Panel>

        {/* Data health */}
        <Panel title="Data health" subtitle="Provenance, freshness and known gaps">
          {loading ? (
            <RowSkeleton rows={3} />
          ) : !snapshot ? (
            <EmptyState message="No snapshot loaded." />
          ) : (
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Data mode</dt>
                <dd className="mt-0.5 font-medium">
                  {snapshot.mode === "LIVE"
                    ? "LIVE public data (source trades & positions) + DERIVED paper simulation"
                    : "DEMO/SAMPLE data + DERIVED paper simulation"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Fetched at</dt>
                <dd className="mt-0.5 font-medium tabular-nums">
                  {new Date(snapshot.fetchedAt).toLocaleString("en-US")}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Public endpoints used</dt>
                <dd className="mt-0.5 space-y-0.5">
                  {snapshot.sources.map((s) => (
                    <p key={s} className="break-all font-mono text-xs text-muted-foreground">
                      {s}
                    </p>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Trade identity basis</dt>
                <dd className="mt-0.5 font-medium">
                  {[...new Set(snapshot.trades.map((t) => t.idBasis))].join(", ") || "n/a"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase text-muted-foreground">Open P&L marks</dt>
                <dd className="mt-0.5">
                  {derived?.hasFreshMark
                    ? `Fresh source marks available for ${derived.openMarkCoverage} simulated positions; the rest report Unavailable.`
                    : "No reliable fresh mark — all open P&L reports Unavailable."}
                </dd>
              </div>
              {snapshot.fallbackReason ? (
                <div className="sm:col-span-2 rounded-md bg-[var(--warn-soft)] px-3 py-2 text-[var(--warn)]">
                  <dt className="text-xs font-semibold uppercase">Why fallback is active</dt>
                  <dd className="mt-0.5">{snapshot.fallbackReason}</dd>
                </div>
              ) : null}
              {snapshot.warnings.length ? (
                <div className="sm:col-span-2">
                  <dt className="text-xs uppercase text-muted-foreground">Notes</dt>
                  <dd className="mt-0.5 space-y-1 text-muted-foreground">
                    {snapshot.warnings.map((w) => (
                      <p key={w}>{w}</p>
                    ))}
                  </dd>
                </div>
              ) : null}
            </dl>
          )}
        </Panel>
      </div>

      <footer className="mt-8 border-t border-border pt-4 text-xs text-muted-foreground">
        Read-only monitor. Paper copy figures are a simulation derived from public fills — not
        advice, not executed trades, and no trading credentials are used anywhere in this app.
      </footer>
    </main>
  );
}
