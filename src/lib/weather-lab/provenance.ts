/**
 * Data provenance and no-lookahead enforcement.
 *
 * Every weather model feed and every market quote carries three timestamps:
 *   issuedAt    - when the producing system published it
 *   validAt     - the time the value describes
 *   retrievedAt - when we actually pulled it
 *
 * A decision made at time T may only consume observations whose `issuedAt` is
 * at or before T. The research phase's failures were not caused by lookahead,
 * but forward paper results are only worth anything if lookahead is structurally
 * impossible rather than merely intended, so this is enforced in code and
 * tested, not left to reviewer discipline.
 */

export type SourceKind =
  | "STATION_OBSERVATION"
  | "METAR"
  | "NBM"
  | "HRRR"
  | "GFS"
  | "GEFS"
  | "ECMWF_DERIVED"
  | "MARKET_QUOTE";

export type ProvenancedDatum<T> = {
  source: SourceKind;
  /** Specific feed identity, e.g. "api.weather.gov/stations/KNYC". */
  sourceId: string;
  issuedAt: Date;
  validAt: Date;
  retrievedAt: Date;
  value: T;
};

export type StalenessPolicy = {
  /** Max age of `issuedAt` relative to decision time before the datum is stale. */
  maxIssueAgeMs: number;
  /** Max age of `retrievedAt` relative to decision time. Guards frozen caches. */
  maxRetrievalAgeMs: number;
};

export type AdmissionResult<T> =
  | { admitted: true; datum: ProvenancedDatum<T> }
  | { admitted: false; reason: string };

export class LookaheadError extends Error {
  constructor(sourceId: string, issuedAt: Date, decisionTime: Date) {
    super(
      `Lookahead rejected for ${sourceId}: issuedAt ${issuedAt.toISOString()} ` +
        `is after decision time ${decisionTime.toISOString()}`,
    );
    this.name = "LookaheadError";
  }
}

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * Admit a datum for use in a decision made at `decisionTime`.
 *
 * Rejects rather than throws for staleness (an ordinary, expected condition),
 * but throws for lookahead, which is a programming error that must never be
 * silently skipped past.
 */
export function admit<T>(
  datum: ProvenancedDatum<T>,
  decisionTime: Date,
  policy: StalenessPolicy,
): AdmissionResult<T> {
  for (const [name, value] of [
    ["issuedAt", datum.issuedAt],
    ["validAt", datum.validAt],
    ["retrievedAt", datum.retrievedAt],
  ] as const) {
    if (!isValidDate(value)) return { admitted: false, reason: `${name} is not a valid date` };
  }
  if (!isValidDate(decisionTime)) return { admitted: false, reason: "decisionTime is not a valid date" };

  if (datum.issuedAt.getTime() > decisionTime.getTime()) {
    throw new LookaheadError(datum.sourceId, datum.issuedAt, decisionTime);
  }
  if (datum.retrievedAt.getTime() > decisionTime.getTime()) {
    throw new LookaheadError(datum.sourceId, datum.retrievedAt, decisionTime);
  }

  const issueAge = decisionTime.getTime() - datum.issuedAt.getTime();
  if (issueAge > policy.maxIssueAgeMs) {
    return { admitted: false, reason: `stale: issued ${Math.round(issueAge / 1000)}s before decision` };
  }

  const retrievalAge = decisionTime.getTime() - datum.retrievedAt.getTime();
  if (retrievalAge > policy.maxRetrievalAgeMs) {
    return { admitted: false, reason: `stale: retrieved ${Math.round(retrievalAge / 1000)}s before decision` };
  }

  return { admitted: true, datum };
}

/** Admit a whole feed set, reporting exactly which sources were dropped and why. */
export function admitAll<T>(
  data: ReadonlyArray<ProvenancedDatum<T>>,
  decisionTime: Date,
  policy: StalenessPolicy,
): { admitted: Array<ProvenancedDatum<T>>; rejected: Array<{ sourceId: string; reason: string }> } {
  const admitted: Array<ProvenancedDatum<T>> = [];
  const rejected: Array<{ sourceId: string; reason: string }> = [];
  for (const d of data) {
    const r = admit(d, decisionTime, policy);
    if (r.admitted) admitted.push(r.datum);
    else rejected.push({ sourceId: d.sourceId, reason: r.reason });
  }
  return { admitted, rejected };
}

/** Which distinct model families survived admission. Feeds the confidence score. */
export function admittedSourceKinds<T>(data: ReadonlyArray<ProvenancedDatum<T>>): SourceKind[] {
  return [...new Set(data.map((d) => d.source))].sort();
}
