import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Panel, EmptyState } from "@/components/mirror/panels";
import { formatShares, formatUsd } from "@/lib/mirror-trader";
import {
  decidePmusPreview,
  getPmusPanel,
  verifyPmusConnectionFn,
} from "@/lib/pmus.functions";

function usd(v: number | null): string {
  return v === null ? "Unavailable" : formatUsd(v);
}

function shares(v: number | null): string {
  return v === null ? "—" : formatShares(v);
}

function stamp(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted"; children: string }) {
  const cls =
    tone === "ok"
      ? "bg-primary/10 text-primary"
      : tone === "warn"
        ? "bg-secondary text-secondary-foreground"
        : tone === "bad"
          ? "bg-destructive/10 text-destructive"
          : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>
  );
}

export function PmusSection() {
  const queryClient = useQueryClient();
  const load = useServerFn(getPmusPanel);
  const { data, isPending, isError } = useQuery({
    queryKey: ["pmus-panel"],
    queryFn: () => load(),
    refetchInterval: 30_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["pmus-panel"] });
  const verify = useMutation({ mutationFn: useServerFn(verifyPmusConnectionFn), onSuccess: invalidate });
  const decide = useMutation({ mutationFn: useServerFn(decidePmusPreview), onSuccess: invalidate });

  const conn = data?.connection;

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Panel
        title="Account setup — Polymarket US"
        subtitle="Read-only balances, positions and order previews. Order submission is not implemented anywhere in this app."
      >
        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading integration status…</p>
        ) : isError || !conn ? (
          <p className="text-sm text-destructive">Could not load integration status.</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={conn.configured ? "ok" : "warn"}>
                {conn.configured ? "Credentials configured" : "Credentials not configured"}
              </Badge>
              <Badge tone={conn.connected ? "ok" : conn.configured ? "bad" : "muted"}>
                {conn.connected ? "Connection verified" : "Connection not verified"}
              </Badge>
              <Badge tone="muted">{`Last verified: ${
                stamp(conn.lastVerifiedAt)
              }`}</Badge>
            </div>

            {conn.detail ? <p className="text-xs text-muted-foreground">{conn.detail}</p> : null}

            {conn.accountSummary ? (
              <dl className="grid grid-cols-2 gap-3 rounded-md border border-border p-3 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Buying power</dt>
                  <dd className="font-medium">{usd(conn.accountSummary.buyingPower)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Balance</dt>
                  <dd className="font-medium">{usd(conn.accountSummary.currentBalance)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Asset notional</dt>
                  <dd className="font-medium">{usd(conn.accountSummary.assetNotional)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Open positions</dt>
                  <dd className="font-medium">{conn.accountSummary.openPositions ?? "—"}</dd>
                </div>
              </dl>
            ) : null}

            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60"
              onClick={() => verify.mutate(undefined)}
              disabled={verify.isPending}
            >
              {verify.isPending ? "Verifying…" : "Verify Polymarket connection"}
            </button>
          </div>
        )}
      </Panel>

      <Panel
        title="Approval queue"
        subtitle="Approving marks a preview ready for MANUAL execution. It never submits, signs or cancels a live order."
      >
        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading approval queue…</p>
        ) : !data ? (
          <p className="text-sm text-destructive">Could not load the approval queue.</p>
        ) : data.pending.length === 0 ? (
          <EmptyState
            message={
              conn?.configured
                ? "No previews awaiting approval. Previews appear when the follower detects a compatible trade with an exact Polymarket US market match."
                : "No previews awaiting approval. Add Polymarket US credentials to generate order previews."
            }
          />
        ) : (
          <ul className="space-y-3">
            {data.pending.map((card) => (
              <li key={card.id} className="rounded-md border border-border p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{card.marketTitle ?? card.usMarketSlug ?? "—"}</span>
                  <Badge tone="ok">{card.compatibility}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Field label="Source market" value={card.marketTitle ?? "—"} />
                  <Field label="US market" value={card.usMarketSlug ?? "—"} />
                  <Field label="Source action" value={`${card.sourceSide} ${card.outcome ?? ""}`} />
                  <Field label="Source price" value={usd(card.sourcePrice)} />
                  <Field label="Candidate size" value={`${shares(card.candidateShares)} sh`} />
                  <Field label="Candidate notional" value={usd(card.candidateNotional)} />
                  <Field label="Preview side" value={card.previewSide ?? "—"} />
                  <Field label="Preview price" value={usd(card.previewPrice)} />
                  <Field label="Preview qty" value={shares(card.previewQuantity)} />
                  <Field label="Est. cost" value={usd(card.previewEstimatedCost)} />
                  <Field label="Available balance" value={usd(card.availableBalance)} />
                  <Field label="Detected" value={stamp(card.createdAt)} />
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    className="rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground disabled:opacity-60"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({ data: { previewId: card.id, decision: "approve" } })
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-border px-3 py-1 font-medium disabled:opacity-60"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({ data: { previewId: card.id, decision: "reject" } })
                    }
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {data ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {`Pending ${data.counts.pending} · Ready for manual execution ${data.counts.approved} · Rejected ${data.counts.rejected} · Not eligible ${data.counts.ineligible}`}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}