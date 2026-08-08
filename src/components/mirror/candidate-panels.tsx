import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { EmptyState, Panel, RowSkeleton } from "@/components/mirror/panels";
import { formatUsd } from "@/lib/mirror-trader";
import {
  getCandidatePanel,
  promoteCandidateFn,
  runCandidateResearchFn,
} from "@/lib/candidates.functions";
import { rankCandidates, type SortKey } from "@/lib/candidates/scoring";

function scoreText(v: number | null): string {
  return v === null ? "Unavailable" : String(Math.round(v));
}

function pct(v: number | null): string {
  return v === null ? "Unavailable" : `${(v * 100).toFixed(0)}%`;
}

function usd(v: number | null): string {
  return v === null ? "Unavailable" : formatUsd(v);
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "final", label: "Final score" },
  { key: "mirror", label: "Mirror similarity" },
  { key: "profit", label: "Profit quality" },
  { key: "copyability", label: "Copyability" },
  { key: "weeklyRank", label: "Weekly rank" },
];

export function CandidateSection() {
  const queryClient = useQueryClient();
  const fetchPanel = useServerFn(getCandidatePanel);
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["candidate-panel"],
    queryFn: () => fetchPanel(),
    refetchInterval: 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["candidate-panel"] });
  const runResearch = useServerFn(runCandidateResearchFn);
  const promoteFn = useServerFn(promoteCandidateFn);
  const research = useMutation({ mutationFn: () => runResearch(), onSuccess: invalidate });
  const promote = useMutation({
    mutationFn: (candidateId: string) => promoteFn({ data: { candidateId } }),
    onSuccess: invalidate,
  });

  const [sort, setSort] = useState<SortKey>("final");
  const [resolvedOnly, setResolvedOnly] = useState(false);
  const [sufficientOnly, setSufficientOnly] = useState(false);
  const [weatherOnly, setWeatherOnly] = useState(false);
  const [promotedFilter, setPromotedFilter] = useState<"ALL" | "PROMOTED" | "NOT_PROMOTED">("ALL");

  const rows = useMemo(() => {
    const list = (data?.candidates ?? [])
      .filter((c) => (resolvedOnly ? c.walletResolved : true))
      .filter((c) => (sufficientOnly ? c.scoreStatus === "SCORED" : true))
      .filter((c) => (weatherOnly ? (c.weatherShare ?? 0) >= 0.7 : true))
      .filter((c) =>
        promotedFilter === "ALL"
          ? true
          : promotedFilter === "PROMOTED"
            ? c.status === "PROMOTED_TO_SHADOW"
            : c.status !== "PROMOTED_TO_SHADOW",
      )
      .map((c) => ({ ...c, weeklyRank: c.weeklyRank }));
    return rankCandidates(list, sort);
  }, [data, sort, resolvedOnly, sufficientOnly, weatherOnly, promotedFilter]);

  return (
    <Panel
      title="Research / Candidate Watchlist"
      subtitle="RESEARCH / SHADOW ONLY — candidates are never followed automatically. Weekly figures are a user-observed leaderboard snapshot, not verified long-term P&L."
      action={
        <button
          type="button"
          onClick={() => research.mutate()}
          disabled={research.isPending}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {research.isPending ? "Researching…" : "Run public research pass"}
        </button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">Sort</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-md border border-border bg-background px-2 py-1"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={resolvedOnly} onChange={(e) => setResolvedOnly(e.target.checked)} />
          Resolved wallet
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={sufficientOnly} onChange={(e) => setSufficientOnly(e.target.checked)} />
          Sufficient data
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={weatherOnly} onChange={(e) => setWeatherOnly(e.target.checked)} />
          Weather specialist
        </label>
        <select
          value={promotedFilter}
          onChange={(e) => setPromotedFilter(e.target.value as "ALL" | "PROMOTED" | "NOT_PROMOTED")}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          <option value="ALL">All</option>
          <option value="PROMOTED">Promoted</option>
          <option value="NOT_PROMOTED">Not promoted</option>
        </select>
      </div>

      {(() => {
        const summary = research.data && research.data.ok ? research.data.summary : null;
        const runState = data?.runState ?? null;
        const state = research.isPending
          ? "running"
          : research.isError || (research.data && !research.data.ok)
            ? "error"
            : (summary?.state ?? (runState?.running ? "running" : runState?.state ?? "idle"));
        const tone =
          state === "error"
            ? "text-[var(--loss)]"
            : state === "partial"
              ? "text-amber-600"
              : state === "success"
                ? "text-[var(--gain)]"
                : "text-muted-foreground";
        const lastRun = summary?.ranAt ?? runState?.lastRunAt ?? null;
        const resolved = summary?.resolvedCount ?? null;
        const unresolvedCount = summary?.unresolvedCount ?? null;
        return (
          <div className="mb-3 rounded-md border border-border px-3 py-2 text-[11px]">
            <p>
              <span className="uppercase tracking-wide text-muted-foreground">Research run</span>{" "}
              <span className={`font-semibold uppercase ${tone}`}>{state}</span>
              {" · last run "}
              {lastRun ? new Date(lastRun).toLocaleString("en-US") : "never"}
              {resolved !== null ? ` · resolved ${resolved}` : ""}
              {unresolvedCount !== null ? ` · unresolved ${unresolvedCount}` : ""}
              {summary && summary.failures.length > 0 ? ` · failed ${summary.failures.length}` : ""}
            </p>
            {research.isError ? (
              <p className="mt-1 text-[var(--loss)]">
                {research.error instanceof Error ? research.error.message : "research pass failed"}
              </p>
            ) : null}
            {research.data && !research.data.ok ? (
              <p className="mt-1 text-[var(--loss)]">Research pass failed: {research.data.error}</p>
            ) : null}
            {summary?.detail ? <p className="mt-1 text-muted-foreground">{summary.detail}</p> : null}
            {!summary && runState?.detail ? (
              <p className="mt-1 text-muted-foreground">{runState.detail}</p>
            ) : null}
          </div>
        );
      })()}
      {promote.data && !promote.data.ok ? (
        <p className="mb-3 rounded-md border border-border px-3 py-2 text-xs text-[var(--loss)]">
          {promote.data.error}
        </p>
      ) : null}

      {isPending ? (
        <RowSkeleton rows={5} />
      ) : isError ? (
        <EmptyState message={`Could not load candidates: ${error instanceof Error ? error.message : "unknown error"}`} />
      ) : rows.length === 0 ? (
        <EmptyState message="No candidates match the current filters. Run the public research pass to populate metrics." />
      ) : (
        <ul className="space-y-3">
          {rows.map((c) => (
            <li key={c.id} className="rounded-lg border border-border px-3 py-3 text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-card-foreground">
                    {c.handle}{" "}
                    <span className="text-[11px] font-normal text-muted-foreground">{c.status}</span>
                  </p>
                  <p className="break-all text-[11px] text-muted-foreground">
                    {c.wallet ?? "wallet_unresolved = true"}{" "}
                    <span className={c.walletResolved ? "text-[var(--gain)]" : "text-[var(--loss)]"}>
                      · wallet resolved: {c.walletResolved ? "yes" : "no"}
                    </span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums">{scoreText(c.finalScore)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Final score · {c.scoreStatus ?? "NOT_SCORED"} · completeness {pct(c.scoreCompleteness)}
                  </p>
                </div>
              </div>

              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
                <Cell label="Weekly rank / P&L" value={`${c.weeklyRank ?? "—"} · ${usd(c.weeklyPnl)}`} />
                <Cell label="7d settled P&L" value={usd(c.pnl7d)} />
                <Cell label="30d settled P&L" value={usd(c.pnl30d)} />
                <Cell label="All-time settled P&L" value={usd(c.pnlAllTime)} />
                <Cell label="Sample (fills / settled)" value={`${c.sampleCount} / ${c.settledSampleCount ?? "—"}`} />
                <Cell label="Weather share" value={pct(c.weatherShare)} />
                <Cell label="Mirror similarity" value={scoreText(c.mirrorSimilarity)} />
                <Cell label="Profit quality" value={scoreText(c.profitQuality)} />
                <Cell
                  label="Copyability"
                  value={`${scoreText(c.copyability)} (data ${pct(c.copyabilityCompleteness)})`}
                />
                <Cell label="Consistency / capacity" value={`${scoreText(c.consistency)} / ${scoreText(c.capacity)}`} />
                <Cell label="Coverage" value={`${day(c.coverageStart)} → ${day(c.coverageEnd)}`} />
                <Cell
                  label="Last activity"
                  value={c.lastActivityTs ? new Date(c.lastActivityTs * 1000).toISOString().slice(0, 16).replace("T", " ") : "Unavailable"}
                />
              </dl>

              {c.strengths.length ? (
                <p className="mt-2 text-[11px] text-[var(--gain)]">Strengths: {c.strengths.join(" · ")}</p>
              ) : null}
              {c.risks.length ? (
                <p className="mt-1 text-[11px] text-[var(--loss)]">Risks: {c.risks.join(" · ")}</p>
              ) : null}
              {c.notes ? <p className="mt-1 text-[11px] text-muted-foreground">{c.notes}</p> : null}
              {c.botLikelihood !== null ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Bot likelihood {c.botLikelihood}/100 — BEHAVIORAL / PROBABILISTIC, not proof of automation.
                </p>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => promote.mutate(c.id)}
                  disabled={!c.walletResolved || promote.isPending || c.status === "PROMOTED_TO_SHADOW"}
                  className="rounded-lg border border-border px-3 py-1.5 text-[11px] font-medium hover:bg-muted disabled:opacity-50"
                >
                  {c.status === "PROMOTED_TO_SHADOW" ? "Promoted (PAUSED)" : "Promote to shadow experiment"}
                </button>
                <span className="text-[11px] text-muted-foreground">
                  Promotion creates an isolated PAUSED / RESEARCH_READY paper experiment. It does not start following.
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground/90">{value}</dd>
    </div>
  );
}
