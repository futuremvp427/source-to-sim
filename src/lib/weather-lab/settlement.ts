/**
 * Settlement rule fingerprinting, fail-closed.
 *
 * The research phase established that the settlement framework moved: Kalshi
 * daily temperature markets transitioned from the National Weather Service to
 * The Weather Company effective 2026-08-14, and the international Polymarket
 * contracts studied earlier settle from Wunderground. Three distinct providers
 * have now been in play, and a historical replay written against the old one is
 * measuring a rule that is no longer in force.
 *
 * Consequences enforced here:
 * - A contract whose settlement semantics we cannot pin down is marked
 *   SETTLEMENT_UNVERIFIED and must never be paper traded.
 * - Every market carries a rule fingerprint. If the fingerprint changes
 *   mid-experiment, that is a rule change, not a data blip, and the affected
 *   station-days must be excluded rather than blended.
 */

export type SettlementStatus = "SETTLEMENT_VERIFIED" | "SETTLEMENT_UNVERIFIED";

export type SettlementRule = {
  /** e.g. "The Weather Company". Verbatim from the venue. */
  provider: string;
  /** Public URL the venue names as the official data location. */
  providerUrl: string | null;
  /** Station or location identifier the contract names, e.g. "CLINYC". */
  station: string;
  /** What is measured, e.g. "maximum temperature". */
  measurement: string;
  /** IANA timezone whose calendar day defines the settlement window. */
  timezone: string;
  /** Unit the contract settles in. */
  unit: "F" | "C";
  /** Whether the venue documents rounding/conversion caveats. */
  roundingNote: string | null;
  /** Venue-declared revision/correction behaviour, when stated. */
  revisionNote: string | null;
};

export type SettlementAssessment = {
  status: SettlementStatus;
  fingerprint: string;
  rule: SettlementRule | null;
  /** Human-readable reasons the contract is not verified. Empty when verified. */
  problems: string[];
};

/**
 * Providers this research programme has audited well enough to price against.
 * Anything else fails closed. Adding a provider is a deliberate, reviewable act.
 */
export const AUDITED_SETTLEMENT_PROVIDERS: readonly string[] = Object.freeze([
  "The Weather Company",
]);

/** Stations audited per venue. A city is not enabled by inference from another. */
export const AUDITED_STATIONS: readonly string[] = Object.freeze([
  "CLINYC",
  "CLICHI",
  "CLILAX",
  "CLISFO",
  "CLIMIA",
]);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Deterministic, order-independent fingerprint of the settlement semantics.
 * Synchronous and dependency-free so it can run inside validation paths; this
 * is a change-detector, not a security primitive.
 */
export function settlementFingerprint(rule: SettlementRule): string {
  const canonical = stableStringify({
    provider: rule.provider,
    station: rule.station,
    measurement: rule.measurement,
    timezone: rule.timezone,
    unit: rule.unit,
    rounding: rule.roundingNote ?? "",
    revision: rule.revisionNote ?? "",
  });
  // FNV-1a 64-bit, rendered hex. Stable across processes and platforms.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return `sfp1-${hash.toString(16).padStart(16, "0")}`;
}

/** Assess a candidate rule. Returns UNVERIFIED with reasons rather than throwing. */
export function assessSettlement(rule: Partial<SettlementRule> | null | undefined): SettlementAssessment {
  const problems: string[] = [];

  if (!rule) {
    return { status: "SETTLEMENT_UNVERIFIED", fingerprint: "sfp1-unknown", rule: null, problems: ["no settlement rule supplied"] };
  }

  const required: Array<keyof SettlementRule> = ["provider", "station", "measurement", "timezone", "unit"];
  for (const key of required) {
    const v = rule[key];
    if (typeof v !== "string" || v.trim() === "") problems.push(`missing ${key}`);
  }

  if (rule.provider && !AUDITED_SETTLEMENT_PROVIDERS.includes(rule.provider)) {
    problems.push(`settlement provider ${JSON.stringify(rule.provider)} is not audited`);
  }
  if (rule.station && !AUDITED_STATIONS.includes(rule.station)) {
    problems.push(`station ${JSON.stringify(rule.station)} is not audited`);
  }
  if (rule.unit && rule.unit !== "F" && rule.unit !== "C") {
    problems.push(`unit ${JSON.stringify(rule.unit)} is not a supported settlement unit`);
  }

  if (problems.length > 0) {
    return { status: "SETTLEMENT_UNVERIFIED", fingerprint: "sfp1-unknown", rule: null, problems };
  }

  const complete = rule as SettlementRule;
  return {
    status: "SETTLEMENT_VERIFIED",
    fingerprint: settlementFingerprint(complete),
    rule: complete,
    problems: [],
  };
}

/**
 * Extract a settlement rule from the venue's own series/market payloads.
 * Returns null when the venue does not state enough to pin the rule down; the
 * caller must then treat the contract as SETTLEMENT_UNVERIFIED.
 */
export function settlementRuleFromKalshi(input: {
  seriesSettlementSources?: Array<{ name?: string | null; url?: string | null }> | null;
  rulesPrimary?: string | null;
  timezone: string;
}): Partial<SettlementRule> | null {
  const source = input.seriesSettlementSources?.[0];
  if (!source?.name) return null;

  const rules = input.rulesPrimary ?? "";
  // e.g. "...recorded at New York City (CLINYC) for Aug 27, 2026..."
  const station = /\(([A-Z]{3,8})\)/.exec(rules)?.[1] ?? null;
  const measurement = /maximum temperature/i.test(rules)
    ? "maximum temperature"
    : /minimum temperature/i.test(rules)
      ? "minimum temperature"
      : null;
  const unit = /fahrenheit/i.test(rules) ? "F" : /celsius/i.test(rules) ? "C" : null;

  if (!station || !measurement || !unit) return null;

  return {
    provider: source.name,
    providerUrl: source.url ?? null,
    station,
    measurement,
    timezone: input.timezone,
    unit,
    roundingNote: /rounding and conversion/i.test(rules) ? "venue documents rounding/conversion caveats" : null,
    revisionNote: /preliminary/i.test(rules) ? "venue warns preliminary readings may be revised" : null,
  };
}

/** A fingerprint change mid-experiment is a rule change, not noise. */
export function settlementChanged(before: string, after: string): boolean {
  return before !== after;
}
