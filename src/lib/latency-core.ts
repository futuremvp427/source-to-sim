/**
 * Latency decomposition for the source-to-decision pipeline.
 *
 * Copying latency is NOT a single number. Each recorded pipeline_audit row
 * carries four wall-clock checkpoints, and this module splits the interval
 * between them into named stages so that decision latency is never presented
 * as if it were the whole source-to-decision delay:
 *
 *   source_ts ──▶ detected_at ──▶ event_persisted_at ──▶ decision_at
 *     publish+poll        ingest/persist        strategy decision
 *
 * The first stage bundles the exchange's own publication delay with our poll
 * interval, because the public API exposes no separate "published at" field:
 * they are not separable from observable data and are labelled as such.
 * Every stage is a median over the sampled rows, and a stage with no usable
 * sample reports null (never zero).
 */

import { median } from "./copyability/core";

export type AuditTimings = {
  /** Source fill timestamp, unix SECONDS as published by the source API. */
  sourceTs: number | null;
  detectedAt: string | null;
  eventPersistedAt: string | null;
  decisionAt: string | null;
};

export type LatencyBreakdown = {
  samples: number;
  /** Source publication + our polling interval; not separable from public data. */
  medianPublishPollSeconds: number | null;
  /** Detection to durable persistence of the source event. */
  medianIngestSeconds: number | null;
  /** Persistence to the deterministic paper decision. */
  medianDecisionSeconds: number | null;
  /** End-to-end source timestamp to decision. */
  medianSourceToDecisionSeconds: number | null;
};

const EMPTY: LatencyBreakdown = {
  samples: 0,
  medianPublishPollSeconds: null,
  medianIngestSeconds: null,
  medianDecisionSeconds: null,
  medianSourceToDecisionSeconds: null,
};

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function delta(fromMs: number | null, toMs: number | null): number | null {
  if (fromMs === null || toMs === null) return null;
  const seconds = (toMs - fromMs) / 1000;
  // Negative intervals mean clock skew between the source and our workers.
  // They are dropped rather than clamped to zero, which would flatter us.
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 10) / 10;
}

function medianOf(values: (number | null)[]): number | null {
  const usable = values.filter((v): v is number => v !== null);
  if (usable.length === 0) return null;
  const m = median(usable);
  return m === null ? null : Math.round(m * 10) / 10;
}

export function summarizeLatency(rows: AuditTimings[]): LatencyBreakdown {
  if (rows.length === 0) return EMPTY;

  const publishPoll: (number | null)[] = [];
  const ingest: (number | null)[] = [];
  const decision: (number | null)[] = [];
  const total: (number | null)[] = [];

  for (const row of rows) {
    const sourceMs =
      row.sourceTs === null || !Number.isFinite(row.sourceTs) ? null : Number(row.sourceTs) * 1000;
    const detected = ms(row.detectedAt);
    const persisted = ms(row.eventPersistedAt);
    const decided = ms(row.decisionAt);

    publishPoll.push(delta(sourceMs, detected));
    ingest.push(delta(detected, persisted));
    decision.push(delta(persisted, decided));
    total.push(delta(sourceMs, decided));
  }

  return {
    samples: rows.length,
    medianPublishPollSeconds: medianOf(publishPoll),
    medianIngestSeconds: medianOf(ingest),
    medianDecisionSeconds: medianOf(decision),
    medianSourceToDecisionSeconds: medianOf(total),
  };
}