/** Activity screen: source trades, paper decisions, open positions, settled P&L. */
import { useMemo, useState } from "react";

import { formatShares, formatTime, formatUsd, isWeatherMarket } from "@/lib/mirror-trader";
import { pnlTone } from "@/lib/ui/portfolio-view";
import { useShadowDashboard } from "@/lib/ui/use-dashboard-queries";

import { EmptyState, RowSkeleton, SideTag } from "./panels";
import { Chip, Metric, TerminalCard } from "./terminal";

function ago(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function ActivityView() {
  const { data, isPending } = useShadowDashboard();
  const [search, setSearch] = useState("");
  const [side, setSide] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [weatherOnly, setWeatherOnly] = useState(true);

  const events = data?.events ?? [];
  const exp = data?.experiment;
  const totals = data?.totals;

  const weatherCounts = useMemo(() => {
    let weather = 0;
    for (const e of events) if (isWeatherMarket(e.marketTitle, e.slug ?? undefined)) weather += 1;
    return { weather, other: events.length - weather };
  }, [events]);

  const filteredEvents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter(
      (e) =>
        (side === "ALL" || e.side === side) &&
        (!q || e.marketTitle.toLowerCase().includes(q)) &&
        (!weatherOnly || isWeatherMarket(e.marketTitle, e.slug ?? undefined)),
    );
  }, [events, search, side, weatherOnly]);

  const filteredPaper = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.paperTrades ?? []).filter(
      (t) =>
        (side === "ALL" || t.side === side) &&
        (!q || t.marketTitle.toLowerCase().includes(q)) &&
        (!weatherOnly || isWeatherMarket(t.marketTitle)),
    );
  }, [data?.paperTrades, search, side, weatherOnly]);

  return (
    <div className="space-y-3">
      <TerminalCard title="Filters" subtitle="Bounded reader — newest stored rows only">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search markets…"
            className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <div className="flex rounded-md border border-border bg-card p-0.5">
            {(["ALL", "BUY", "SELL"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`rounded px-3 py-1.5 text-xs font-medium ${
                  side === s ? "bg-muted text-foreground" : "text-muted-foreground"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setWeatherOnly((v) => !v)}
            className={`rounded-md border px-3 py-2 text-xs font-medium ${
              weatherOnly ? "border-primary bg-primary/10 text-primary" : "border-border bg-card"
            }`}
          >
            Weather only {weatherOnly ? "ON" : "OFF"}
          </button>
          <span className="text-[11px] text-muted-foreground">
            HEURISTIC: {weatherCounts.weather} weather / {weatherCounts.other} other (title + slug
            keywords, not authoritative)
          </span>
        </div>
      </TerminalCard>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <TerminalCard
          title="Detected source trades"
          subtitle={`Persisted public fills — ${totals?.persistedEvents ?? 0} stored in total, newest 300 shown`}
        >
          {isPending ? (
            <RowSkeleton />
          ) : filteredEvents.length === 0 ? (
            <EmptyState message="No stored source trades match these filters yet." />
          ) : (
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-2 font-medium">Market</th>
                    <th className="py-2 pr-2 font-medium">Side</th>
                    <th className="py-2 pr-2 text-right font-medium">Shares</th>
                    <th className="py-2 pr-2 text-right font-medium">Price</th>
                    <th className="py-2 pr-2 font-medium">Source time</th>
                    <th className="py-2 font-medium">Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((e) => (
                    <tr key={e.eventKey} className="border-t border-border align-top">
                      <td className="max-w-[16rem] py-2 pr-2">
                        <span className="line-clamp-2">{e.marketTitle}</span>
                        <span className="text-muted-foreground">
                          {e.outcome ?? "—"}
                          {e.identityDegraded ? " · degraded id" : ""}
                          {e.processed ? "" : " · pending"}
                        </span>
                      </td>
                      <td className="py-2 pr-2">
                        <SideTag side={e.side} />
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatShares(e.shares)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{e.price.toFixed(3)}</td>
                      <td className="py-2 pr-2 whitespace-nowrap text-muted-foreground">
                        {formatTime(e.sourceTs)}
                      </td>
                      <td className="py-2 whitespace-nowrap text-muted-foreground">
                        {new Date(e.firstSeenAt).toLocaleTimeString("en-US")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TerminalCard>

        <TerminalCard
          title="Paper copy activity"
          subtitle="PAPER SIMULATION / DERIVED — persisted decisions, including skips with reasons"
        >
          {isPending ? (
            <RowSkeleton />
          ) : filteredPaper.length === 0 ? (
            <EmptyState message="No paper decisions match these filters yet." />
          ) : (
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-2 font-medium">Market</th>
                    <th className="py-2 pr-2 font-medium">Action</th>
                    <th className="py-2 pr-2 text-right font-medium">Shares</th>
                    <th className="py-2 pr-2 text-right font-medium">Notional</th>
                    <th className="py-2 pr-2 text-right font-medium">Cash after</th>
                    <th className="py-2 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPaper.map((t) => (
                    <tr key={t.id} className="border-t border-border align-top">
                      <td className="max-w-[14rem] py-2 pr-2">
                        <span className="line-clamp-2">{t.marketTitle}</span>
                        <span className="text-muted-foreground">
                          {t.sourceTs ? formatTime(t.sourceTs) : "—"}
                        </span>
                      </td>
                      <td className="py-2 pr-2">
                        <Chip
                          tone={t.action === "BUY" ? "ok" : t.action === "SELL" ? "bad" : "muted"}
                        >
                          {t.action}
                        </Chip>
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatShares(t.shares)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatUsd(t.notional)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                        {t.cashAfter === null ? "—" : formatUsd(t.cashAfter)}
                      </td>
                      <td className="max-w-[14rem] py-2 text-muted-foreground">{t.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TerminalCard>
      </div>

      <TerminalCard
        title="Open paper positions"
        subtitle="PAPER SIMULATION. Open P&L is Unavailable unless a fresh public CLOB mark exists (max 120s old)."
      >
        {isPending ? (
          <RowSkeleton />
        ) : (data?.open.length ?? 0) === 0 ? (
          <EmptyState message="No open simulated positions." />
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-2 font-medium">Market</th>
                  <th className="py-2 pr-2 text-right font-medium">Shares</th>
                  <th className="py-2 pr-2 text-right font-medium">Avg</th>
                  <th className="py-2 pr-2 text-right font-medium">Cost basis</th>
                  <th className="py-2 pr-2 text-right font-medium">Mark</th>
                  <th className="py-2 pr-2 text-right font-medium">Open P&L</th>
                  <th className="py-2 font-medium">Mark source</th>
                </tr>
              </thead>
              <tbody>
                {data?.open.map((p) => (
                  <tr key={p.asset} className="border-t border-border">
                    <td className="max-w-[22rem] py-2 pr-2">
                      <span className="line-clamp-2">{p.marketTitle}</span>
                      <span className="text-muted-foreground">{p.outcome ?? "—"}</span>
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatShares(p.shares)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{p.avgPrice.toFixed(3)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatUsd(p.costBasis)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {p.mark === null ? (
                        <span className="text-muted-foreground">Unavailable</span>
                      ) : (
                        p.mark.toFixed(3)
                      )}
                    </td>
                    <td
                      className={`py-2 pr-2 text-right tabular-nums ${
                        p.openPnl === null
                          ? "text-muted-foreground"
                          : p.openPnl >= 0
                            ? "text-[var(--gain)]"
                            : "text-[var(--loss)]"
                      }`}
                    >
                      {p.openPnl === null ? "Unavailable" : formatUsd(p.openPnl)}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {p.markSource ? `${p.markSource} · ${ago(p.markAgeSeconds)}` : "no fresh mark"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TerminalCard>

      <TerminalCard
        title="Settled paper P&L"
        subtitle="DERIVED from the persisted source-trade log — realized on simulated exits only"
      >
        {isPending ? (
          <RowSkeleton rows={3} />
        ) : (
          <>
            <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Metric
                label="Realized paper P&L"
                value={formatUsd(exp?.realizedPnl ?? 0)}
                tone={pnlTone(exp?.realizedPnl ?? null)}
                hint="Sum of simulated closes since the follower started persisting"
              />
              <Metric
                label="Source settled P&L"
                value="Unavailable"
                tone="muted"
                hint="The public Data API exposes no verified closed/settled positions endpoint, so no lifetime source total is invented."
              />
            </div>
            {(data?.closed.length ?? 0) === 0 ? (
              <EmptyState message="No fully closed simulated positions yet." />
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-2 font-medium">Market</th>
                    <th className="py-2 pr-2 text-right font-medium">Realized</th>
                    <th className="py-2 pr-2 font-medium">Type</th>
                    <th className="py-2 font-medium">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.closed.map((c) => (
                    <tr key={c.asset} className="border-t border-border">
                      <td className="max-w-[18rem] py-2 pr-2">
                        <span className="line-clamp-2">{c.marketTitle}</span>
                      </td>
                      <td
                        className={`py-2 pr-2 text-right tabular-nums ${
                          c.realizedPnl >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]"
                        }`}
                      >
                        {formatUsd(c.realizedPnl)}
                      </td>
                      <td className="py-2 pr-2 text-muted-foreground">
                        {c.settlementStatus === "settled_won"
                          ? "Settled Won"
                          : c.settlementStatus === "settled_lost"
                            ? "Settled Lost"
                            : "Sold"}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {c.lastActivityTs ? formatTime(c.lastActivityTs) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </TerminalCard>
    </div>
  );
}