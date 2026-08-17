/** System screen: operator controls, worker/data health and all ops diagnostics. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import {
  acknowledgeAlerts,
  runReconciliation,
  triggerIngest,
  updateShadowSettings,
} from "@/lib/shadow.functions";
import { useShadowDashboard } from "@/lib/ui/use-dashboard-queries";

import { RowSkeleton } from "./panels";
import { TerminalCard } from "./terminal";
import {
  CapacityComparisonSection,
  ComparisonSection,
  EvidenceSection,
  SelfCheckSection,
  V2StatusSection,
} from "./comparison-panels";
import { ObservationLogSection } from "./observation-panel";
import { GeneralShadowSection } from "./general-shadow-panel";
import { LiveSafetySection } from "./live-safety-panel";
import { PoligarchLivePilotPanel } from "./poligarch-live-pilot-panel";
import { PmusSection } from "./pmus-panels";

function ago(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function SystemView() {
  const { data, isPending } = useShadowDashboard();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["shadow-dashboard"] });

  const ingest = useMutation({ mutationFn: useServerFn(triggerIngest), onSuccess: invalidate });
  const reconcileNow = useMutation({
    mutationFn: useServerFn(runReconciliation),
    onSuccess: invalidate,
  });
  const ackAlerts = useMutation({
    mutationFn: useServerFn(acknowledgeAlerts),
    onSuccess: invalidate,
  });
  const saveSettings = useMutation({
    mutationFn: useServerFn(updateShadowSettings),
    onSuccess: invalidate,
  });

  const exp = data?.experiment;
  const worker = data?.worker;
  const totals = data?.totals;
  const events = data?.events ?? [];
  const unackAlerts = (data?.alerts ?? []).filter((a) => !a.acknowledged);

  return (
    <div className="space-y-3">
      {ingest.data && ingest.data.ok === false ? (
        <TerminalCard>
          <p className="text-sm text-[var(--loss)]">Manual poll failed: {ingest.data.error}</p>
        </TerminalCard>
      ) : null}

      <TerminalCard
        title="Follower controls"
        subtitle="Simulation-only settings. Nothing here can place, sign or cancel a real order."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="text-xs">
            <span className="font-medium text-muted-foreground">BUY sizing (active)</span>
            <p className="mt-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm">
              dynamic-v1 — automatic
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              min($5, 1% of spendable cash), $1 floor, 10% reserve. Not user-configurable; the legacy
              fixed paper buy amount no longer affects V2.
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
          <div className="space-y-2 text-xs">
            <span className="font-medium text-muted-foreground">Maintenance</span>
            <button
              type="button"
              onClick={() => reconcileNow.mutate({} as never)}
              disabled={reconcileNow.isPending}
              className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
            >
              {reconcileNow.isPending ? "Reconciling…" : "Reconcile from event replay"}
            </button>
            <button
              type="button"
              onClick={() => ingest.mutate({} as never)}
              disabled={ingest.isPending}
              className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
            >
              {ingest.isPending ? "Polling…" : "Poll now"}
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
      </TerminalCard>

      <TerminalCard
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
              {totals?.totalEventsPersisted ?? 0} persisted in total (lifetime, counted from stored
              events) ·{" "}
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
              {data?.degradedIdentityCount ?? 0} of {events.length} shown events used the degraded
              tx-hash + ordinal fallback (the public feed exposes no trade id or log index). Identical
              same-second fills are preserved, never collapsed.
            </Row>
            <Row label="Marks">
              Public CLOB order book mid, refreshed each poll. Marks older than 120s are discarded and
              open P&L reads Unavailable rather than showing a stale number.
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
                              ? "text-[var(--warn)]"
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
      </TerminalCard>

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
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 pb-2 sm:flex-row sm:gap-3">
      <dt className="w-40 shrink-0 font-medium text-muted-foreground">{label}</dt>
      <dd className="text-foreground/90">{children}</dd>
    </div>
  );
}