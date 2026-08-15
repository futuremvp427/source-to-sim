import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { EmptyState, Panel, RowSkeleton } from "@/components/mirror/panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Json } from "@/integrations/supabase/types";
import {
  abortPoligarchToLocked,
  enterPoligarchLivePilotStage,
  enterPoligarchPreviewStage,
  getLatestPoligarchIntents,
  getPoligarchPilotSafety,
  setPoligarchKillSwitch,
} from "@/lib/live-pilot/poligarch-safety.functions";
import { formatUsd } from "@/lib/mirror-trader";

type StatusHistoryEntry = { status: string; at: string };

/**
 * `status_history` is stored as jsonb — an array of
 * `{ status, at, fields? }` objects appended by
 * `update_live_pilot_intent_status_atomic` (see
 * supabase/migrations/20260815121000_poligarch_live_pilot_intent_rpc.sql).
 * Parsed defensively since it's typed as `Json` end-to-end.
 */
function parseStatusHistory(value: Json): StatusHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: StatusHistoryEntry[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const status = item["status"];
    const at = item["at"];
    if (typeof status === "string" && typeof at === "string") {
      entries.push({ status, at });
    }
  }
  return entries;
}

function historyTimeLabel(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString("en-US");
}

function usd(v: number | null | undefined): string {
  return v === null || v === undefined ? "Unavailable" : formatUsd(v);
}

const OPEN_INTENT_STATUSES = new Set([
  "AUTHORIZED",
  "SUBMITTING",
  "SUBMITTED",
  "PARTIALLY_FILLED",
  "FILLED",
]);

function stageBadgeVariant(stage: string): "destructive" | "secondary" | "outline" {
  if (stage === "live_pilot") return "destructive";
  if (stage === "preview") return "secondary";
  return "outline";
}

function intentStatusVariant(status: string): "destructive" | "secondary" | "outline" {
  if (["REJECTED", "FAILED", "CANCELLED"].includes(status)) return "destructive";
  if (["FILLED", "PARTIALLY_FILLED", "SUBMITTED", "AUTHORIZED"].includes(status))
    return "secondary";
  return "outline";
}

/**
 * Admin dashboard panel for the Poligarch V2 live pilot ONLY.
 *
 * Read-mostly: every query and every mutation here is scoped exclusively to
 * `pilot_id = 'poligarch_v2_live_pilot'` via Task 8's admin-gated server
 * functions (`poligarch-safety.functions.ts`) and this task's
 * `getLatestPoligarchIntents`. No other wallet's or pilot's data can ever
 * appear here — this panel never imports `live-safety.functions.ts` or any
 * other experiment's data source.
 *
 * No production caller in this plan invokes the preview pipeline against
 * live signals yet, so "last signal" / "latest preview" / "latest order
 * status" / the audit history table will legitimately be empty in
 * production today — that's expected, not a bug.
 */
export function PoligarchLivePilotPanel() {
  const queryClient = useQueryClient();
  const loadSafety = useServerFn(getPoligarchPilotSafety);
  const loadIntents = useServerFn(getLatestPoligarchIntents);
  const [phrase, setPhrase] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const safetyQuery = useQuery({
    queryKey: ["poligarch-pilot-safety"],
    queryFn: () => loadSafety(),
    refetchInterval: 60_000,
    retry: false,
  });

  const intentsQuery = useQuery({
    queryKey: ["poligarch-pilot-intents"],
    queryFn: () => loadIntents(),
    refetchInterval: 60_000,
    retry: false,
  });

  const kill = useServerFn(setPoligarchKillSwitch);
  const preview = useServerFn(enterPoligarchPreviewStage);
  const livePilot = useServerFn(enterPoligarchLivePilotStage);
  const abort = useServerFn(abortPoligarchToLocked);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["poligarch-pilot-safety"] }),
      queryClient.invalidateQueries({ queryKey: ["poligarch-pilot-intents"] }),
    ]);
  };

  const act = useMutation({
    mutationFn: async (action: "engage" | "release" | "preview" | "live_pilot" | "abort") => {
      if (action === "engage") return kill({ data: { engaged: true } });
      if (action === "release") return kill({ data: { engaged: false } });
      if (action === "preview") return preview({});
      if (action === "live_pilot") return livePilot({ data: { confirmPhrase: phrase } });
      return abort({});
    },
    onSuccess: async () => {
      setMessage("Action applied.");
      setPhrase("");
      await invalidate();
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const data = safetyQuery.data;
  const intents = intentsQuery.data ?? [];
  const latestIntent = intents[0] ?? null;
  const openPositionsCount = intents.filter((i) => OPEN_INTENT_STATUSES.has(i.status)).length;

  return (
    <Panel
      title="Poligarch V2 live pilot"
      subtitle="Kill switch, two-step activation and order-intent audit trail for this pilot only. No live order path is reachable from here. Sign in as an administrator to view."
    >
      {safetyQuery.isPending ? (
        <RowSkeleton rows={4} />
      ) : safetyQuery.isError || !data ? (
        <EmptyState message="Administrator sign-in required to view the Poligarch V2 live pilot." />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={data.killSwitchEngaged ? "destructive" : "secondary"}>
              Kill switch {data.killSwitchEngaged ? "ENGAGED" : "released"}
            </Badge>
            <Badge variant={stageBadgeVariant(data.activationStage)}>
              Stage: {data.activationStage.toUpperCase()}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Pilot bankroll (configured)" value={usd(data.pilotBankrollUsd)} />
            <Metric label="Per-order cap" value={usd(data.maxOrderNotionalUsd)} />
            <Metric label="Total exposure cap" value={usd(data.maxTotalExposureUsd)} />
            <Metric label="Daily realized-loss cap" value={usd(data.maxDailyRealizedLossUsd)} />
            <Metric
              label="Current exposure"
              value="Unavailable"
              hint="No production caller runs the preview pipeline against live signals yet"
            />
            <Metric
              label="Today's realized P&L"
              value="Unavailable"
              hint="No live ledger snapshot has ever been persisted"
            />
            <Metric
              label="Open positions"
              value={intents.length === 0 ? "Unavailable" : String(openPositionsCount)}
              hint={
                intents.length === 0
                  ? "No order intents recorded yet"
                  : "Derived from the last 20 intents' status only"
              }
            />
            <Metric
              label="Latest order status"
              value={latestIntent ? latestIntent.status.replace(/_/g, " ") : "No intents yet"}
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Last signal / latest preview
            </p>
            {latestIntent ? (
              <div className="rounded-md border p-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {latestIntent.sourceSide} {latestIntent.usMarketSlug ?? "(unmapped market)"}
                  </span>
                  <Badge variant={intentStatusVariant(latestIntent.status)}>
                    {latestIntent.status.replace(/_/g, " ")}
                  </Badge>
                </div>
                <div className="mt-1 grid gap-1 text-muted-foreground">
                  <span>Source price {latestIntent.sourcePrice.toFixed(3)}</span>
                  {latestIntent.requestedNotionalUsd !== null && (
                    <span>
                      Requested {usd(latestIntent.requestedNotionalUsd)} (
                      {latestIntent.requestedShares ?? "—"} shares)
                    </span>
                  )}
                  {latestIntent.failReason && <span>Fail reason: {latestIntent.failReason}</span>}
                  <span>Detected {new Date(latestIntent.detectedAt).toLocaleString("en-US")}</span>
                </div>
              </div>
            ) : (
              <EmptyState message="No signals evaluated yet — no caller wires the preview pipeline against live signals in this plan yet." />
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Audit history (last {intents.length})
            </p>
            {intentsQuery.isPending ? (
              <RowSkeleton rows={3} />
            ) : intentsQuery.isError ? (
              <EmptyState message="Could not load the order-intent audit history." />
            ) : intents.length === 0 ? (
              <EmptyState message="No order intents recorded yet for this pilot." />
            ) : (
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-2 font-medium">Status</th>
                      <th className="py-1 pr-2 font-medium">Market</th>
                      <th className="py-1 pr-2 font-medium">History</th>
                      <th className="py-1 pr-2 font-medium">Detected</th>
                      <th className="py-1 font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intents.map((i) => (
                      <tr key={i.id} className="border-t border-border align-top">
                        <td className="py-1 pr-2">
                          <Badge variant={intentStatusVariant(i.status)}>
                            {i.status.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="py-1 pr-2 text-muted-foreground">
                          {i.usMarketSlug ?? "(unmapped)"}
                        </td>
                        <td className="py-1 pr-2">
                          <StatusHistoryCell history={i.statusHistory} />
                        </td>
                        <td className="py-1 pr-2 whitespace-nowrap text-muted-foreground">
                          {new Date(i.detectedAt).toLocaleString("en-US")}
                        </td>
                        <td className="py-1 whitespace-nowrap text-muted-foreground">
                          {new Date(i.updatedAt).toLocaleString("en-US")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={act.isPending}
              onClick={() => act.mutate("engage")}
            >
              Engage kill switch
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending || !data.killSwitchEngaged}
              onClick={() => act.mutate("release")}
            >
              Release kill switch
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending || data.activationStage !== "locked"}
              onClick={() => act.mutate("preview")}
            >
              Enter preview (step 1 of 2)
            </Button>
            <Input
              className="h-8 w-64"
              placeholder="ACTIVATE POLIGARCH V2 LIVE PILOT"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
            <Button
              size="sm"
              disabled={act.isPending || data.activationStage !== "preview"}
              onClick={() => act.mutate("live_pilot")}
            >
              Enter live pilot (step 2 of 2)
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={act.isPending || data.activationStage === "locked"}
              onClick={() => act.mutate("abort")}
            >
              Abort to locked
            </Button>
          </div>

          {message && <p className="text-xs text-muted-foreground">{message}</p>}
          <p className="text-xs text-muted-foreground">
            No live order path exists anywhere in this codebase yet — activating this pilot only
            arms the preview pipeline; order submission remains structurally unreachable.
          </p>
        </div>
      )}
    </Panel>
  );
}

/**
 * Compact, bounded rendering of an intent's status_history for the audit
 * table: every transition if there are 4 or fewer, otherwise the first,
 * a "+N more" marker, and the last (most recent) transition.
 */
function StatusHistoryCell({ history }: { history: Json }) {
  const entries = parseStatusHistory(history);
  if (entries.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const shown =
    entries.length <= 4
      ? entries.map((e, idx) => ({ entry: e, key: String(idx) }))
      : [
          { entry: entries[0]!, key: "first" },
          { entry: null, key: "gap", gapCount: entries.length - 2 },
          { entry: entries[entries.length - 1]!, key: "last" },
        ];
  return (
    <ul className="space-y-0.5">
      {shown.map((row) =>
        row.entry ? (
          <li key={row.key} className="whitespace-nowrap">
            <span className="font-medium">{row.entry.status.replace(/_/g, " ")}</span>{" "}
            <span className="text-muted-foreground">@ {historyTimeLabel(row.entry.at)}</span>
          </li>
        ) : (
          <li key={row.key} className="text-muted-foreground">
            ⋮ {row.gapCount} more
          </li>
        ),
      )}
    </ul>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
      {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
