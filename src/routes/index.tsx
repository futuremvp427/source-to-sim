import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

import { EmptyState, Panel, RowSkeleton, SideTag, Stat } from "@/components/mirror/panels";
import { CandidateSection } from "@/components/mirror/candidate-panels";
import {
  CapacityComparisonSection,
  ComparisonSection,
  EvidenceSection,
  SelfCheckSection,
  V2StatusSection,
} from "@/components/mirror/comparison-panels";
import { PmusSection } from "@/components/mirror/pmus-panels";
import { ObservationLogSection } from "@/components/mirror/observation-panel";
import { GeneralShadowSection } from "@/components/mirror/general-shadow-panel";
import { LiveSafetySection } from "@/components/mirror/live-safety-panel";
import { PoligarchLivePilotPanel } from "@/components/mirror/poligarch-live-pilot-panel";
import { formatShares, formatTime, formatUsd, isWeatherMarket } from "@/lib/mirror-trader";
import { isWorkerHealthy } from "@/lib/worker-health";
import {
  acknowledgeAlerts,
  getShadowDashboard,
  runReconciliation,
  triggerIngest,
  updateShadowSettings,
} from "@/lib/shadow.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MirrorWeather Shadow Bot — Paper Copy Follower" },
      {
        name: "description",
        content:
          "Autonomous read-only Polymarket wallet follower with a persistent paper-copy simulation: source trades, proportional paper fills, positions, P&L, worker health.",
      },
      { property: "og:title", content: "MirrorWeather Shadow Bot — Paper Copy Follower" },
      {
        property: "og:description",
        content:
          "Persistent, autonomous paper-copy follower for a fixed Polymarket wallet. Simulation only — no orders, no credentials.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const REFRESH_MS = 20_000;

function pnlTone(v: number | null) {
  if (v === null) return "muted" as const;
  return v >= 0 ? ("positive" as const) : ("negative" as const);
}

function ago(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function Dashboard() {
  const fetchDashboard = useServerFn(getShadowDashboard);
  const queryClient = useQueryClient();

  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: ["shadow-dashboard"],
    queryFn: () => fetchDashboard(),
    refetchInterval: REFRESH_MS,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["shadow-dashboard"] });
  const ingest = useMutation({ mutationFn: useServerFn(triggerIngest), onSuccess: invalidate });
  const reconcileNow = useMutation({
    mutationFn: useServerFn(runReconciliation),
    onSuccess: invalidate,
  });
  const ackAlerts = useMutation({ mutationFn: useServerFn(acknowledgeAlerts), onSuccess: invalidate });
  const saveSettings = useMutation({
    mutationFn: useServerFn(updateShadowSettings),
    onSuccess: invalidate,
  });

  const [search, setSearch] = useState("");
  const [side, setSide] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [weatherOnly, setWeatherOnly] = useState(true);
  const [operatorEmail, setOperatorEmail] = useState<string | null>(null);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setOperatorEmail(data.user?.email ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      setOperatorEmail(session?.user.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const events = data?.events ?? [];
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

  const exp = data?.experiment;
  const worker = data?.worker;
  const totals = data?.totals;
  const unackAlerts = (data?.alerts ?? []).filter((a) => !a.acknowledged);
  const workerHealthy = isWorkerHealthy(worker);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">MirrorWeather Shadow Bot</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Autonomous, persistent <strong>PAPER SIMULATION</strong> follower of a fixed public
              Polymarket wallet. Read-only monitoring — no credentials, no signing, no real orders.
            </p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {data?.wallet ?? "…"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${
                workerHealthy
                  ? "border-[var(--gain)]/40 bg-[var(--gain-soft)] text-[var(--gain)]"
                  : "border-[var(--loss)]/40 bg-[var(--loss-soft)] text-[var(--loss)]"
              }`}
            >
              <span className="size-1.5 rounded-full bg-current" />
              Worker {worker?.state ?? "unknown"} · heartbeat {ago(worker?.heartbeatAgeSeconds ?? null)}
            </span>
            <button
              type="button"
              onClick={() => ingest.mutate({} as never)}
              disabled={ingest.isPending}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
            >
              {ingest.isPending ? "Polling…" : "Poll now"}
            </button>
            <button
              type="button"
              onClick={() => invalidate()}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
            {operatorEmail ? (
              <button
                type="button"
                onClick={async () => {
                  await queryClient.cancelQueries();
                  await supabase.auth.signOut();
                }}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Sign out {operatorEmail}
              </button>
            ) : (
              <Link
                to="/auth"
                className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Operator sign in
              </Link>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Last updated {data ? new Date(data.fetchedAt).toLocaleString("en-US") : "…"} · auto-refresh
          every {REFRESH_MS / 1000}s · the follower keeps running on a schedule with this page closed.
        </p>
      </header>

      {isError ? (
        <div className="mb-6 rounded-xl border border-[var(--loss)]/40 bg-[var(--loss-soft)] px-4 py-3 text-sm text-[var(--loss)]">
          Could not load the follower state: {error instanceof Error ? error.message : "unknown error"}
        </div>
      ) : null}

      {ingest.data && ingest.data.ok === false ? (
        <div className="mb-6 rounded-xl border border-[var(--loss)]/40 bg-[var(--loss-soft)] px-4 py-3 text-sm text-[var(--loss)]">
          Manual poll failed: {ingest.data.error}
        </div>
      ) : null}

      {/* ---------------- Overview ---------------- */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Simulated cash"
          value={exp ? formatUsd(exp.cash) : "…"}
          hint={exp ? `Started at ${formatUsd(exp.startingCash)} (simulated money)` : undefined}
        />
        <Stat
          label="Open cost basis"
          value={totals ? formatUsd(totals.openCostBasis) : "…"}
          hint={totals ? `${totals.openPositions} open paper position(s)` : undefined}
        />
        <Stat
          label="Realized paper P&L"
          value={exp ? formatUsd(exp.realizedPnl) : "…"}
          tone={pnlTone(exp?.realizedPnl ?? null)}
          hint="DERIVED from persisted source trades"
        />
        <Stat
          label="Simulated equity"
          value={totals?.equity == null ? "Unavailable" : formatUsd(totals.equity)}
          tone={totals?.equity == null ? "muted" : "default"}
          hint={
            totals?.equity == null
              ? "Needs a fresh mark for every open position"
              : "Cash + marked open value"
          }
        />
      </div>

      {/* ------- V2 fair-comparison cohort ------- */}
      <V2StatusSection />

      <ComparisonSection />

      <CapacityComparisonSection />
      <ObservationLogSection />

      <GeneralShadowSection />

      <EvidenceSection />

      <SelfCheckSection />

      <LiveSafetySection />

      <PoligarchLivePilotPanel />

      <PmusSection />

      <CandidateSection />

      {/* ---------------- Controls ---------------- */}
      <Panel
        title="Follower controls"
        subtitle="Simulation-only settings. Nothing here can place, sign or cancel a real order."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Legacy knobs are read-only facts: they do not drive active V2 behaviour. */}
          <div className="text-xs">
            <span className="font-medium text-muted-foreground">BUY sizing (active)</span>
            <p className="mt-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm">
              dynamic-v1 — automatic
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              min($5, 1% of spendable cash), $1 floor, 10% reserve. Not user-configurable; the
              legacy fixed paper buy amount no longer affects V2.
            </p>
          </div>
          <div className="text-xs">
            <span className="font-medium text-muted-foreground">Polling cadence (active)</span>
            <p className="mt-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm">
              Every minute — scheduled
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Controlled by the server-side scheduler, not by the legacy poll-interval setting.
            </p>
          </div>
          <div className="text-xs">
            <span className="font-medium text-muted-foreground">Follower</span>
            <button
              type="button"
              onClick={() => saveSettings.mutate({ data: { enabled: !exp?.enabled } } as never)}
              disabled={!exp || saveSettings.isPending}
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
            >
              {exp?.enabled ? "Running — click to pause" : "Paused — click to resume"}
            </button>
          </div>
          <div className="text-xs">
            <span className="font-medium text-muted-foreground">Maintenance</span>
            <button
              type="button"
              onClick={() => reconcileNow.mutate({} as never)}
              disabled={reconcileNow.isPending}
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
            >
              {reconcileNow.isPending ? "Reconciling…" : "Reconcile from event replay"}
            </button>
          </div>
        </div>
        {reconcileNow.data ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {reconcileNow.data.ok
              ? `Reconciliation complete — ${reconcileNow.data.mismatches ?? 0} mismatch(es) repaired from the persisted event log.`
              : `Reconciliation failed: ${reconcileNow.data.error}`}
          </p>
        ) : null}
      </Panel>

      {/* ---------------- Filters ---------------- */}
      <div className="my-6 flex flex-wrap items-center gap-2">
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
        <span className="text-xs text-muted-foreground">
          HEURISTIC: {weatherCounts.weather} weather / {weatherCounts.other} other (title + slug
          keywords, not authoritative)
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* ---------------- Source trades ---------------- */}
        <Panel
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
        </Panel>

        {/* ---------------- Paper activity ---------------- */}
        <Panel
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
                        <span
                          className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                            t.action === "BUY"
                              ? "bg-[var(--gain-soft)] text-[var(--gain)]"
                              : t.action === "SELL"
                                ? "bg-[var(--loss-soft)] text-[var(--loss)]"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {t.action}
                        </span>
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
        </Panel>
      </div>

      {/* ---------------- Positions ---------------- */}
      <div className="mt-6">
        <Panel
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
                        {p.markSource
                          ? `${p.markSource} · ${ago(p.markAgeSeconds)}`
                          : "no fresh mark"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {/* ---------------- Settled ---------------- */}
      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel
          title="Settled paper P&L"
          subtitle="DERIVED from the persisted source-trade log — realized on simulated exits only"
        >
          {isPending ? (
            <RowSkeleton rows={3} />
          ) : (
            <>
              <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Stat
                  label="Realized paper P&L"
                  value={formatUsd(exp?.realizedPnl ?? 0)}
                  tone={pnlTone(exp?.realizedPnl ?? null)}
                  hint="Sum of simulated closes since the follower started persisting"
                />
                <Stat
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
        </Panel>

        {/* ---------------- Worker / data health ---------------- */}
        <Panel
          title="Worker & data health"
          subtitle="Autonomy, persistence and provenance"
          action={
            unackAlerts.length > 0 ? (
              <button
                type="button"
                onClick={() => ackAlerts.mutate({} as never)}
                className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
              >
                Acknowledge {unackAlerts.length}
              </button>
            ) : null
          }
        >
          {isPending ? (
            <RowSkeleton rows={5} />
          ) : (
            <dl className="space-y-2 text-xs">
              <Row label="Worker state">
                {worker?.state} · id {worker?.workerId ?? "—"} · fence {worker?.fence}
              </Row>
              <Row label="Heartbeat">
                {ago(worker?.heartbeatAgeSeconds ?? null)}
                {worker?.lastSuccessAt
                  ? ` · last success ${new Date(worker.lastSuccessAt).toLocaleTimeString("en-US")}`
                  : ""}
              </Row>
              <Row label="Ingestion lag">
                {worker?.lagSeconds == null
                  ? "Unavailable"
                  : `${worker.lagSeconds}s behind newest source fill`}
              </Row>
              <Row label="Events">
                {totals?.totalEventsPersisted ?? 0} persisted in total (lifetime, counted from
                stored events) ·{" "}
                {totals?.lastPollEventsInserted == null
                  ? "latest poll insert count unavailable"
                  : `${totals.lastPollEventsInserted} inserted by the latest poll`}{" "}
                · bootstrap {worker?.bootstrapComplete ? "complete" : "pending"}
              </Row>
              <Row label="Source data completeness">
                {data?.sourceCompleteness.status ?? "Unavailable"}
                {data?.sourceCompleteness.detail ? ` — ${data.sourceCompleteness.detail}` : ""}
              </Row>
              <Row label="Poll failures">
                {worker?.pollFailures ?? 0}
                {worker?.lastError ? ` · last error: ${worker.lastError}` : ""}
              </Row>
              <Row label="Identity quality">
                {data?.degradedIdentityCount ?? 0} of {events.length} shown events used the
                degraded tx-hash + ordinal fallback (the public feed exposes no trade id or log
                index). Identical same-second fills are preserved, never collapsed.
              </Row>
              <Row label="Marks">
                Public CLOB order book mid, refreshed each poll. Marks older than 120s are discarded
                and open P&L reads Unavailable rather than showing a stale number.
              </Row>
              <Row label="Safety">
                Read-only public endpoints only. No API keys, no signing, no order placement, no
                withdrawal path. All balances are simulated money.
              </Row>
              {(data?.alerts.length ?? 0) > 0 ? (
                <div className="mt-3 border-t border-border pt-2">
                  <p className="mb-1 font-medium text-muted-foreground">Recent alerts</p>
                  <ul className="space-y-1">
                    {data?.alerts.slice(0, 8).map((a) => (
                      <li key={a.id} className="text-muted-foreground">
                        <span
                          className={
                            a.level === "error"
                              ? "text-[var(--loss)]"
                              : a.level === "warn"
                                ? "text-[var(--warn,inherit)]"
                                : ""
                          }
                        >
                          [{a.level}]
                        </span>{" "}
                        {a.message}{" "}
                        <span className="opacity-70">
                          {new Date(a.createdAt).toLocaleTimeString("en-US")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </dl>
          )}
        </Panel>
      </div>

      <footer className="mt-8 border-t border-border pt-4 text-xs text-muted-foreground">
        PAPER SIMULATION ONLY. Every number labelled paper/simulated is derived from public data and
        involves no real funds. Sources: data-api.polymarket.com (trades), clob.polymarket.com (order
        book marks).
      </footer>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 pb-2 sm:flex-row sm:gap-3">
      <dt className="w-40 shrink-0 font-medium text-muted-foreground">{label}</dt>
      <dd className="text-foreground/90">{children}</dd>
    </div>
  );
}
