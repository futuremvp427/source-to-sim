/**
 * Pure, deterministic copyability math.
 *
 * Everything here works on REAL OBSERVED public CLOB samples only. A sample
 * that could not be observed stays null and is never treated as zero, and a
 * wallet without enough evidence returns INSUFFICIENT_DATA instead of a
 * fabricated numeric score.
 */

export type Side = "BUY" | "SELL";

export type SampleDelay = "immediate" | "30s" | "60s" | "5m" | "15m";

export const SAMPLE_DELAYS: readonly { delay: SampleDelay; seconds: number }[] = Object.freeze([
  { delay: "immediate", seconds: 0 },
  { delay: "30s", seconds: 30 },
  { delay: "60s", seconds: 60 },
  { delay: "5m", seconds: 300 },
  { delay: "15m", seconds: 900 },
]);

/** Weight per delay when aggregating slippage. Renormalized over observed delays. */
export const DELAY_WEIGHTS: Record<SampleDelay, number> = {
  immediate: 0.3,
  "30s": 0.25,
  "60s": 0.2,
  "5m": 0.15,
  "15m": 0.1,
};

export type BookSample = {
  bestBid: number | null;
  bestAsk: number | null;
  /** Exchange-reported midpoint when available; otherwise null. */
  midpoint: number | null;
  /** Visible size at the relevant top-of-book level, in shares. */
  visibleDepth: number | null;
};

export type ObservationMath = {
  followerPrice: number | null;
  midpoint: number | null;
  spread: number | null;
  slippageCents: number | null;
  slippagePct: number | null;
  priceDirection: "UP" | "DOWN" | "FLAT" | null;
  improved: boolean | null;
  fillable: boolean | null;
};

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function positive(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/** Top-of-book spread in cents. Null unless BOTH sides were observed. */
export function spreadCents(sample: BookSample): number | null {
  const bid = positive(sample.bestBid);
  const ask = positive(sample.bestAsk);
  if (bid === null || ask === null) return null;
  return round((ask - bid) * 100, 4);
}

/** Midpoint: exchange midpoint when given, else derived from both sides, else null. */
export function midpointOf(sample: BookSample): number | null {
  const mid = positive(sample.midpoint);
  if (mid !== null) return round(mid, 6);
  const bid = positive(sample.bestBid);
  const ask = positive(sample.bestAsk);
  if (bid === null || ask === null) return null;
  return round((bid + ask) / 2, 6);
}

/**
 * A follower BUY has to pay the observable ASK; a follower SELL only receives
 * the observable BID. Positive slippage always means "worse for the follower".
 */
export function computeObservation(input: {
  side: Side;
  leaderPrice: number | null;
  requiredShares: number | null;
  sample: BookSample;
}): ObservationMath {
  const { side, sample } = input;
  const leader = positive(input.leaderPrice);
  const followerPrice = side === "BUY" ? positive(sample.bestAsk) : positive(sample.bestBid);
  const spread = spreadCents(sample);
  const midpoint = midpointOf(sample);
  const depth = sample.visibleDepth !== null && Number.isFinite(sample.visibleDepth) ? sample.visibleDepth : null;
  const need = positive(input.requiredShares);

  if (followerPrice === null || leader === null) {
    return {
      followerPrice,
      midpoint,
      spread,
      slippageCents: null,
      slippagePct: null,
      priceDirection: null,
      improved: null,
      fillable: depth === null || need === null ? null : depth + 1e-9 >= need,
    };
  }

  const raw = side === "BUY" ? followerPrice - leader : leader - followerPrice;
  const slippageCents = round(raw * 100, 4);
  return {
    followerPrice,
    midpoint,
    spread,
    slippageCents,
    slippagePct: round((raw / leader) * 100, 4),
    priceDirection: followerPrice > leader ? "UP" : followerPrice < leader ? "DOWN" : "FLAT",
    improved: raw < 0,
    fillable: depth === null || need === null ? null : depth + 1e-9 >= need,
  };
}

/* ------------------------------------------------------------------ */
/* Copyability score                                                   */
/* ------------------------------------------------------------------ */

export type ObservationLite = {
  eventKey: string;
  sampleDelay: SampleDelay;
  slippagePct: number | null;
  spread: number | null;
  fillable: boolean | null;
};

export type CopyabilityScore = {
  status: "SCORED" | "INSUFFICIENT_DATA";
  score: number | null;
  completeness: number;
  observedSamples: number;
  expectedSamples: number;
  eventsWithUsableObservation: number;
  medianSlippagePctByDelay: Partial<Record<SampleDelay, number | null>>;
  medianSpreadCents: number | null;
  fillableRatePct: number | null;
  components: { slippage: number | null; spread: number | null; fillability: number | null };
  reason: string;
};

/** Minimum real evidence before a number is honest. */
export const MIN_SCORABLE_EVENTS = 3;
export const MIN_SCORABLE_COMPLETENESS = 0.3;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const v = s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return round(v, 4);
}

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/**
 * Deterministic score:
 *   slippage component = 100 - 10 × (weighted median slippage %, floored at 0)
 *   spread component   = 100 - 10 × median top-of-book spread in cents
 *   fillability        = % of samples where the simulated size fits visible depth
 *   score = 0.5×slippage + 0.2×spread + 0.3×fillability
 * Components with no observations are dropped and the weights renormalized.
 */
export function copyabilityScore(input: {
  observations: ObservationLite[];
  /** Distinct post-go-live events that were scheduled for observation. */
  scheduledEvents: number;
}): CopyabilityScore {
  const expectedSamples = input.scheduledEvents * SAMPLE_DELAYS.length;
  const observed = input.observations.filter(
    (o) => o.slippagePct !== null || o.spread !== null || o.fillable !== null,
  );
  const usableEvents = new Set(observed.filter((o) => o.slippagePct !== null).map((o) => o.eventKey));
  const completeness = expectedSamples === 0 ? 0 : round(observed.length / expectedSamples, 4);

  const medianByDelay: Partial<Record<SampleDelay, number | null>> = {};
  for (const { delay } of SAMPLE_DELAYS) {
    const values = observed
      .filter((o) => o.sampleDelay === delay && o.slippagePct !== null)
      .map((o) => o.slippagePct as number);
    medianByDelay[delay] = median(values);
  }

  let weightSum = 0;
  let weighted = 0;
  for (const { delay } of SAMPLE_DELAYS) {
    const m = medianByDelay[delay];
    if (m === null || m === undefined) continue;
    weightSum += DELAY_WEIGHTS[delay];
    weighted += DELAY_WEIGHTS[delay] * m;
  }
  const weightedSlippagePct = weightSum === 0 ? null : round(weighted / weightSum, 4);

  const medianSpread = median(observed.filter((o) => o.spread !== null).map((o) => o.spread as number));
  const depthSamples = observed.filter((o) => o.fillable !== null);
  const fillableRatePct =
    depthSamples.length === 0
      ? null
      : round((depthSamples.filter((o) => o.fillable === true).length / depthSamples.length) * 100, 2);

  const components = {
    slippage: weightedSlippagePct === null ? null : clamp100(100 - 10 * Math.max(0, weightedSlippagePct)),
    spread: medianSpread === null ? null : clamp100(100 - 10 * Math.max(0, medianSpread)),
    fillability: fillableRatePct === null ? null : clamp100(fillableRatePct),
  };

  const base: Omit<CopyabilityScore, "status" | "score" | "reason"> = {
    completeness,
    observedSamples: observed.length,
    expectedSamples,
    eventsWithUsableObservation: usableEvents.size,
    medianSlippagePctByDelay: medianByDelay,
    medianSpreadCents: medianSpread,
    fillableRatePct,
    components,
  };

  if (usableEvents.size < MIN_SCORABLE_EVENTS || completeness < MIN_SCORABLE_COMPLETENESS) {
    return {
      ...base,
      status: "INSUFFICIENT_DATA",
      score: null,
      reason: `INSUFFICIENT_DATA: ${usableEvents.size} usable event(s) of ${MIN_SCORABLE_EVENTS} required, completeness ${(completeness * 100).toFixed(1)}%`,
    };
  }

  const weights: Array<[number | null, number]> = [
    [components.slippage, 0.5],
    [components.spread, 0.2],
    [components.fillability, 0.3],
  ];
  const usable = weights.filter(([v]) => v !== null) as Array<[number, number]>;
  const wSum = usable.reduce((s, [, w]) => s + w, 0);
  const score = clamp100(usable.reduce((s, [v, w]) => s + v * w, 0) / wSum);
  return {
    ...base,
    status: "SCORED",
    score,
    reason: `Scored from ${observed.length} real observed sample(s) across ${usableEvents.size} post-go-live event(s).`,
  };
}

/* ------------------------------------------------------------------ */
/* Scheduling cursor (durable backlog coverage)                        */
/* ------------------------------------------------------------------ */

/**
 * A latest-N-window scan can permanently strand older unscheduled trades once
 * the backlog exceeds the window. The cursor instead walks the append-only
 * paper_trades stream forward exactly once per row, in stable (created_at,
 * id) order, so backlog of any size is eventually fully covered and newly
 * inserted trades are always reached once the cursor catches up.
 */
export type CursorPosition = { createdAt: string; id: string };

/** True when a row sorts strictly after the given cursor in (created_at, id) order. */
export function isAfterCursor(
  row: { createdAt: string; id: string },
  cursor: CursorPosition | null,
): boolean {
  if (cursor === null) return true;
  if (row.createdAt !== cursor.createdAt) return row.createdAt > cursor.createdAt;
  return row.id > cursor.id;
}

/**
 * Selects the next page after cursor, from rows already sorted ascending by
 * (created_at, id). Mirrors the ORDER BY + tuple WHERE clause issued against
 * paper_trades, so the resume/paging semantics are unit-testable without a
 * database.
 */
export function selectCursorPage<T extends { createdAt: string; id: string }>(
  sortedRows: T[],
  cursor: CursorPosition | null,
  limit: number,
): T[] {
  const startIndex = sortedRows.findIndex((row) => isAfterCursor(row, cursor));
  if (startIndex === -1) return [];
  return sortedRows.slice(startIndex, startIndex + limit);
}

/** Cursor to persist once a page has been successfully scanned: its last row. */
export function nextCursorFor(page: { createdAt: string; id: string }[]): CursorPosition | null {
  const last = page[page.length - 1];
  return last ? { createdAt: last.createdAt, id: last.id } : null;
}