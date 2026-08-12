import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { EmptyState, Panel, RowSkeleton } from "@/components/mirror/panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  abortLiveActivation,
  armLiveActivation,
  confirmLiveActivation,
  getLiveSafety,
  setKillSwitch,
} from "@/lib/live-safety.functions";
import { formatUsd } from "@/lib/mirror-trader";

function usd(v: number | null): string {
  return v === null ? "Unavailable" : formatUsd(v);
}

/**
 * Qualification + live allocation + kill switch + two-step activation.
 * Admin-only, and purely a gate: no live order path exists in this app.
 */
export function LiveSafetySection() {
  const queryClient = useQueryClient();
  const load = useServerFn(getLiveSafety);
  const [phrase, setPhrase] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const { data, isPending, isError } = useQuery({
    queryKey: ["live-safety"],
    queryFn: () => load(),
    refetchInterval: 60_000,
    retry: false,
  });

  const kill = useServerFn(setKillSwitch);
  const arm = useServerFn(armLiveActivation);
  const confirm = useServerFn(confirmLiveActivation);
  const abort = useServerFn(abortLiveActivation);

  const act = useMutation({
    mutationFn: async (action: "engage" | "release" | "arm" | "confirm" | "abort") => {
      if (action === "engage") return kill({ data: { engaged: true } });
      if (action === "release") return kill({ data: { engaged: false } });
      if (action === "arm") return arm({});
      if (action === "confirm") return confirm({ data: { confirmPhrase: phrase } });
      return abort({});
    },
    onSuccess: async (res) => {
      setMessage(res.message);
      setPhrase("");
      await queryClient.invalidateQueries({ queryKey: ["live-safety"] });
    },
    onError: (e: Error) => setMessage(e.message),
  });

  return (
    <Panel
      title="Live safety layer"
      subtitle="Qualification, allocation caps, kill switch and two-step activation. Sign in as an administrator to view."
    >
      {isPending ? (
        <RowSkeleton rows={4} />
      ) : isError || !data ? (
        <EmptyState message="Administrator sign-in required to view the live safety layer." />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={data.state.killSwitchEngaged ? "destructive" : "secondary"}>
              Kill switch {data.state.killSwitchEngaged ? "ENGAGED" : "released"}
            </Badge>
            <Badge variant="outline">Stage: {data.state.activationStage}</Badge>
            <Badge variant="outline">Qualified experiments: {data.qualifiedCount}</Badge>
            <Badge variant="outline">
              Live execution path: {data.liveExecutionImplemented ? "present" : "none"}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Effective live allocation" value={usd(data.allocation.allocationUsd)} />
            <Metric label="Per-order cap" value={usd(data.allocation.perOrderNotionalUsd)} />
            <Metric label="Open exposure (fresh marks)" value={usd(data.exposureUsd)} />
            <Metric label="Exposure cap" value={usd(data.state.maxLiveExposureUsd)} />
          </div>

          {data.allocation.reasons.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {data.allocation.reasons.map((r) => (
                <li key={r}>• {r}</li>
              ))}
            </ul>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Qualification
            </p>
            {data.qualifications.map((q) => (
              <div key={q.id} className="rounded-md border p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {q.cohort} {q.handle}
                  </span>
                  <Badge variant={q.status === "qualified" ? "secondary" : "outline"}>
                    {q.status.replace(/_/g, " ")}
                  </Badge>
                </div>
                <div className="mt-1 grid gap-1 text-xs text-muted-foreground">
                  {q.checks.map((c) => (
                    <span key={c.label}>
                      {c.pass ? "PASS" : "FAIL"} — {c.label}: {c.detail}
                    </span>
                  ))}
                </div>
              </div>
            ))}
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
              disabled={act.isPending || !data.state.killSwitchEngaged}
              onClick={() => act.mutate("release")}
            >
              Release kill switch
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={act.isPending || data.state.activationStage !== "locked"}
              onClick={() => act.mutate("arm")}
            >
              Arm (step 1 of 2)
            </Button>
            <Input
              className="h-8 w-56"
              placeholder={data.confirmPhrase}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
            <Button
              size="sm"
              disabled={act.isPending || data.state.activationStage !== "armed"}
              onClick={() => act.mutate("confirm")}
            >
              Confirm activation (step 2 of 2)
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={act.isPending || data.state.activationStage === "locked"}
              onClick={() => act.mutate("abort")}
            >
              Abort
            </Button>
          </div>

          {message && <p className="text-xs text-muted-foreground">{message}</p>}
          <p className="text-xs text-muted-foreground">{data.note}</p>
        </div>
      )}
    </Panel>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
