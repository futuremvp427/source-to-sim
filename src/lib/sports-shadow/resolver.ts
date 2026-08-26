/**
 * Cross-venue EXACT contract resolver — PURE logic only.
 *
 * Answers: "for this already-ELIGIBLE (Task 3) MLB source signal, which PM-US (Task 5) and/or
 * Kalshi (Task 6) candidate represents the exact same economic contract?" Resolves each venue
 * independently (never compares PM-US to Kalshi, never picks a "winner"). No network calls, no
 * timers, no Supabase — pure functions over already-discovered candidate arrays.
 *
 * FAILS CLOSED throughout: any missing, ambiguous, or contradictory evidence downgrades the
 * result away from EXACT rather than guessing. See the module-level constants below for the
 * one empirically-evidenced exception (a search-scope window, not a match-tolerance).
 *
 * ============================ START-TIME EVIDENCE (bounded live diagnostic) ============================
 * Before choosing any timestamp-matching behavior, real timestamps were compared for the SAME
 * real-world game across venues:
 *   - Source (gamma-api, mlb-min-sd-2026-08-22):  gameStartTime = "2026-08-23 00:40:00+00"
 *   - Kalshi (KXMLBGAME-26AUG222040MINSD-SD):     occurrence_datetime = "2026-08-23T03:40:00Z"
 * These disagree by exactly 3 hours for the identical real game, with no evident fixed-offset
 * explanation discoverable from the data alone. This is NOT clean enough evidence to justify a
 * cross-venue *matching* tolerance (the mission is explicit: do not invent one without real
 * justification) — so source-vs-target timestamps are NEVER compared with any tolerance;
 * disambiguation (below) requires exact millisecond equality or falls to UNVERIFIED.
 *
 * Separately, WITHIN one venue's own candidate list, real PM-US data showed the opposite: the
 * spread and total markets for the identical SFCLE game both reported the exact same
 * `occurrence_datetime` ("2026-08-20T20:10:00Z") — a single venue is internally consistent about
 * one game's start time across bet types. So candidates are clustered into "the same game" only
 * by EXACT timestamp equality (or both null), never a tolerance window — a genuinely different
 * start time within one venue's own data means a genuinely different game (see `groupByGame`).
 * =========================================================================================
 */

import { normalizeTeamName } from "./team-normalization";
import { inferSportsLeagueFromSlug, normalizeParticipantName } from "./participant-normalization";
import type { BetType, SettlementCompatibility } from "./types";
import type { KalshiCandidate } from "./kalshi";
import type { PmusCandidate } from "./pmus";

export type MatchStatus = "EXACT" | "NEAR" | "NONE" | "UNVERIFIED";

export type TargetSide = { kind: "TEAM"; team: string } | { kind: "YES" } | { kind: "NO" } | { kind: "OVER" } | { kind: "UNDER" };

/**
 * Task 12G / P1-J: PM-US's /book endpoint returns exactly ONE order book per market
 * slug -- confirmed EMPIRICALLY (never guessed) via live read-only requests during this
 * task: for a real moneyline market, the book's best bid (0.3950) and best offer
 * (0.4000) exactly matched the market's own `stats.lastPriceSample.longPx` (0.3950) and
 * the complementary `1 - longPx` relationship confirmed by the SAME field's `shortPx`
 * (0.6050 = 1 - 0.3950 exactly); an independently-checked spread market showed the
 * identical relationship (longPx 0.1520, shortPx 0.8480, sum exactly 1.0000). This
 * PROVES: the fetched book represents the market's LONG side, and the SHORT side's
 * economics are the standard complementary-binary-market transform (short_bid =
 * 1 - long_ask, short_ask = 1 - long_bid) -- not a guess, not an invented formula.
 *
 * A PM-US EXACT result's `targetPmusOrientation` (on VenueMatchResult, below) durably
 * carries which side of that ONE book the resolved outcome actually is, independently
 * of the semantic TargetSide (TEAM/OVER/UNDER) -- so downstream quote capture
 * (observation.ts's buildPmusObservationPatch) can apply the complementary transform
 * exactly when required and never when it is not. Always null for Kalshi (YES/NO has no
 * such concept) and for any non-EXACT PMUS result.
 */
export type PmusOrientation = "LONG" | "SHORT";

export type ResolverReasonCode =
  | "EXACT_MATCH"
  | "NEAR_DIFFERENT_LINE"
  | "NEAR_RULE_MISMATCH"
  | "NONE_NO_CANDIDATE"
  | "NONE_WRONG_TEAMS"
  | "UNVERIFIED_AMBIGUOUS_GAME"
  | "UNVERIFIED_AMBIGUOUS_TARGET"
  | "UNVERIFIED_MISSING_START_TIME"
  | "UNVERIFIED_SIDE_ORIENTATION"
  | "UNVERIFIED_RULES"
  | "UNVERIFIED_SOURCE_OUTCOME"
  /** Task 12I / P1-O: the resolver genuinely found an EXACT target, but observation.ts's clampPastCutoffResult downgraded it to UNVERIFIED because persistence happened at or after the signal's pregame recheck cutoff -- never assigned by the resolver itself. */
  | "UNVERIFIED_CUTOFF_EXCEEDED";

/**
 * Already-ELIGIBLE (Task 3) source market identity, plus the one piece Task 3's
 * SourceMarketMetadata does not carry: which specific outcome the source wallet actually
 * bought. `selectedOutcomeRaw` is the raw `outcome` text from the source fill (data-api
 * `/trades` row) — a team name/abbreviation for MONEYLINE/SPREAD, or "Over"/"Under" text for
 * TOTAL. A later task assembles this from SourceMarketMetadata + the fill's own `outcome`
 * field; this resolver does not fetch or derive it itself.
 */
export type SourceSignal = {
  betType: BetType;
  awayTeam: string;
  homeTeam: string;
  gameStartTime: string | null;
  /** Signed for SPREAD (e.g. -1.5 for the away/home team named in selectedOutcomeRaw), magnitude for TOTAL, null for MONEYLINE. */
  line: number | null;
  selectedOutcomeRaw: string;
  conditionId: string;
  /** CODEX P1-6: the source (Polymarket Gamma) market's own resolution-rules text -- see buildSettlementProfile's cross-venue combining logic below. Null when Gamma never returned one for this market. */
  sourceRulesDescription: string | null;
  sourceGameId: string | null;
  eventSlug: string | null;
  marketSlug: string | null;
};

export type RuleDimensionStatus = "EXACT_COMPATIBLE" | "KNOWN_INCOMPATIBLE" | "UNVERIFIED";

export type SettlementProfile = {
  extraInnings: RuleDimensionStatus;
  postponement: RuleDimensionStatus;
  pushRisk: RuleDimensionStatus;
};

export type VenueMatchResult = {
  venue: "PMUS" | "KALSHI";
  status: MatchStatus;
  reasonCode: ResolverReasonCode;
  reason: string;
  sourceConditionId: string;
  sourceMarketSlug: string | null;
  targetEventId: string | null;
  targetMarketId: string | null;
  /** The exact string a caller must pass to fetchPmusBook/fetchKalshiBook to fetch this market's live book — PM-US's marketSlug (NOT the numeric marketId, which fetchPmusBook cannot use) or Kalshi's marketTicker (same value as targetMarketId for Kalshi, kept separate for a uniform cross-venue field). Task 8 depends on this. */
  targetFetchKey: string | null;
  /** Cross-series/doubleheader-safe game identifier: PM-US gameId, Kalshi gameCode. */
  targetGameIdentifier: string | null;
  targetAwayTeam: string | null;
  targetHomeTeam: string | null;
  targetBetType: BetType | null;
  sourceLine: number | null;
  targetLine: number | null;
  sourceStartTime: string | null;
  targetStartTime: string | null;
  targetSide: TargetSide | null;
  /** Task 12G / P1-J: PM-US LONG/SHORT book orientation for this EXACT match -- see PmusOrientation's doc comment. Always null for Kalshi and for any non-EXACT PMUS result. */
  targetPmusOrientation: PmusOrientation | null;
  settlementCompatibility: SettlementCompatibility;
  settlementProfile: SettlementProfile | null;
  candidateCounts: { exact: number; near: number; unverified: number; total: number };
  evidence: string[];
};

function toEpochMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function isHalfPointLine(line: number): boolean {
  return Math.abs(line * 2 - Math.round(line * 2)) < 1e-9 && Math.abs(Math.round(line) - line) > 1e-9;
}

/* ------------------------------- Settlement rules ------------------------------- */

function analyzeExtraInnings(text: string | null): RuleDimensionStatus {
  if (!text) return "UNVERIFIED";
  // Negative pattern checked FIRST: "not included" contains "included" as a substring, so the
  // positive pattern below would otherwise false-match it.
  if (/(extra innings?|overtime(?:\s+periods?)?)\s*(are|is)?\s*(not\s+included|excluded|not\s+counted)/i.test(text)) return "KNOWN_INCOMPATIBLE";
  if (/(extra innings?|overtime(?:\s+periods?)?)\s*(are|is)?\s*(included|counted)|includ\w+\s+(?:any\s+)?(extra innings?|overtime(?:\s+periods?)?)/i.test(text)) {
    return "EXACT_COMPATIBLE";
  }
  return "UNVERIFIED";
}

export type PostponementTreatment = "VOID_ON_POSTPONEMENT" | "REMAINS_OPEN_UNTIL_COMPLETED" | "SETTLES_LAST_FAIR_MARKET_PRICE" | "UNVERIFIED";

/**
 * CODEX P1-5: previously, MERELY MENTIONING postponed/delayed/suspended/rescheduled was
 * treated as proof of cross-venue compatibility -- two ECONOMICALLY OPPOSITE contracts
 * both mention the topic and would both classify EXACT_COMPATIBLE. Example (adversarial,
 * from the finding itself): source text "market remains open until completed" vs. target
 * text "void/cancel if postponed" -- both plainly mention postponement, but describe
 * OPPOSITE outcomes.
 *
 * Classifies the DECLARED TREATMENT instead of merely detecting the topic. A real,
 * live-verified Gamma market description (source-metadata.server.ts's own doc comment)
 * reads "If the game is postponed, this market will remain open until the game has been
 * completed" -- REMAINS_OPEN_UNTIL_COMPLETED. VOID pattern is checked FIRST: a void/
 * cancellation clause's own text often ALSO contains "postponed"/"delayed" as its
 * triggering condition, which the remains-open pattern could otherwise false-match via
 * mere trigger-word presence.
 *
 * Consolidates the mission's full postponement-family list into this ONE binary
 * classification: cancellation/void/no-contest/shortened-or-called-game treatment all
 * collapse to VOID_ON_POSTPONEMENT (the contract does not survive to a later completed
 * game); reschedule window/make-up-game treatment/settlement timing/event identity
 * after rescheduling all collapse to REMAINS_OPEN_UNTIL_COMPLETED (the contract survives
 * to whichever game eventually happens, however delayed). There is no additional REAL,
 * parseable signal in a plain-English market description to split these further without
 * inventing distinctions the text itself does not actually draw -- doing so would
 * fabricate metadata, which this codebase's own established discipline (P1-6's identical
 * reasoning for pushRisk) explicitly refuses to do.
 */
function analyzePostponementTreatment(text: string | null): PostponementTreatment {
  if (!text) return "UNVERIFIED";
  const triggerPattern = /\b(postpon\w*|delay\w*|suspend\w*|resched\w*|call(?:ed)?\s+(?:game|off)|shorten\w*|make[\s-]?up\s+game)\b/i;
  if (!triggerPattern.test(text)) return "UNVERIFIED"; // topic never even raised
  if (/not\s+rescheduled[\s\S]{0,120}\bwithin\s+two\s+weeks\b/i.test(text) && /last\s+fair\s+market\s+price/i.test(text)) return "SETTLES_LAST_FAIR_MARKET_PRICE";
  const remainsOpenPattern = /\b(remains?|stays?)\s+(open|active)\b|will\s+remain\s+open|until\s+(?:the\s+)?game\s+(?:has\s+been\s+|is\s+)?complet\w*/i;
  if (remainsOpenPattern.test(text)) return "REMAINS_OPEN_UNTIL_COMPLETED";
  const voidPattern = /\b(void\w*|cancel\w*|no[\s-]?contest|refund\w*)\b/i;
  if (voidPattern.test(text)) return "VOID_ON_POSTPONEMENT";
  return "UNVERIFIED"; // topic raised, but no decisive declared treatment found -- fail closed, never guess
}

/**
 * Half-point lines (X.5) cannot push/tie for integer-scored baseball runs, so they're always
 * push-safe. Whole-integer lines COULD push; without positively-evidenced venue rules proving
 * both sides resolve a push identically, this stays UNVERIFIED per the mission's explicit
 * "do not assume identical numeric lines imply identical economic contracts" instruction —
 * never assumed compatible from silence.
 */
function analyzePushRisk(line: number | null): RuleDimensionStatus {
  if (line === null) return "EXACT_COMPATIBLE"; // MONEYLINE has no line, no push risk applies
  return isHalfPointLine(line) ? "EXACT_COMPATIBLE" : "UNVERIFIED";
}

/**
 * CODEX P1-6: `analyzeExtraInnings`/`analyzePostponement` each answer "what does THIS
 * side's own text confirm" -- EXACT_COMPATIBLE means confirmed-included/handled,
 * KNOWN_INCOMPATIBLE means confirmed-excluded/different, UNVERIFIED means the text says
 * nothing decisive. Genuine cross-venue economic equivalence requires BOTH sides to
 * confirm the SAME behavior -- same game/team/line alone proves nothing about whether,
 * say, a postponement or an extra-innings rule difference makes them different contracts.
 */
/**
 * Generic over any per-venue classification whose "no decisive signal" value is the
 * literal string "UNVERIFIED" (RuleDimensionStatus itself, for extraInnings; or a
 * richer classification like PostponementTreatment, for postponement -- CODEX P1-5).
 * Same rule either way: neither side positively proving anything is UNVERIFIED (never
 * assume agreement from silence); the two sides confirming the identical treatment is
 * EXACT_COMPATIBLE; the two sides confirming DIFFERENT treatments is a genuine
 * confirmed KNOWN_INCOMPATIBLE mismatch.
 */
function combineDimension<T extends string>(source: T, target: T): RuleDimensionStatus {
  if (source === "UNVERIFIED" || target === "UNVERIFIED") return "UNVERIFIED";
  return source === target ? "EXACT_COMPATIBLE" : "KNOWN_INCOMPATIBLE";
}

/**
 * CODEX P1-6: previously analyzed ONLY the target venue's own rulesDescription --
 * "target text looks unrestrictive" was silently treated as proof of cross-venue
 * equivalence, when it never incorporated what the SOURCE (Polymarket) market's own
 * resolution rules actually say. `sourceRulesText` is confirmed (not invented) to be
 * populated from gamma-api's own `description` field (source-metadata.server.ts) -- the
 * exact same class of resolution-rules text PM-US/Kalshi's own rulesDescription already
 * carries. pushRisk stays source-independent: it is a pure function of the (already
 * exact-equality-required) traded line value itself, not of either venue's prose.
 */
function buildSettlementProfile(targetRulesText: string | null, sourceRulesText: string | null, line: number | null): SettlementProfile {
  return {
    extraInnings: combineDimension(analyzeExtraInnings(sourceRulesText), analyzeExtraInnings(targetRulesText)),
    postponement: combineDimension(analyzePostponementTreatment(sourceRulesText), analyzePostponementTreatment(targetRulesText)),
    pushRisk: analyzePushRisk(line),
  };
}

function overallCompatibility(profile: SettlementProfile): SettlementCompatibility {
  const values = [profile.extraInnings, profile.postponement, profile.pushRisk];
  if (values.some((v) => v === "KNOWN_INCOMPATIBLE")) return "INCOMPATIBLE";
  if (values.every((v) => v === "EXACT_COMPATIBLE")) return "COMPATIBLE";
  return "UNVERIFIED";
}

/* ------------------------------- Source outcome parsing ------------------------------- */

type SourceOutcome =
  | { kind: "MONEYLINE"; team: string }
  | { kind: "SPREAD"; team: string; line: number }
  | { kind: "TOTAL"; direction: "OVER" | "UNDER"; line: number };

function parseSourceOutcome(source: SourceSignal): SourceOutcome | null {
  const sourceLeague = inferSportsLeagueFromSlug(source.marketSlug) ?? inferSportsLeagueFromSlug(source.eventSlug);
  const normalizeSourceTeam = (raw: string): string | null => (sourceLeague ? normalizeParticipantName(raw, sourceLeague) : null) ?? normalizeTeamName(raw);
  if (source.betType === "MONEYLINE") {
    const team = normalizeSourceTeam(source.selectedOutcomeRaw);
    if (!team || (team !== source.awayTeam && team !== source.homeTeam)) return null;
    return { kind: "MONEYLINE", team };
  }
  if (source.betType === "SPREAD") {
    const team = normalizeSourceTeam(source.selectedOutcomeRaw);
    if (!team || (team !== source.awayTeam && team !== source.homeTeam)) return null;
    if (source.line === null || !Number.isFinite(source.line)) return null;
    return { kind: "SPREAD", team, line: source.line };
  }
  const raw = source.selectedOutcomeRaw.toLowerCase();
  const direction = raw.includes("over") ? "OVER" : raw.includes("under") ? "UNDER" : null;
  if (!direction) return null;
  if (source.line === null || !Number.isFinite(source.line)) return null;
  return { kind: "TOTAL", direction, line: source.line };
}

function opponentOf(source: SourceSignal, team: string): string {
  return team === source.awayTeam ? source.homeTeam : source.awayTeam;
}

/* ------------------------------- Generic game grouping ------------------------------- */

type GameBucketResult<C> =
  | { kind: "NONE" }
  | { kind: "UNVERIFIED_AMBIGUOUS"; reason: string }
  /** Task 12G / P1-K: a source or candidate start time is simply absent (as opposed to present-but-contradictory) -- distinct reasonCode (UNVERIFIED_MISSING_START_TIME) from a genuine ambiguity/contradiction. */
  | { kind: "UNVERIFIED_MISSING_TIME"; reason: string }
  | { kind: "FOUND"; candidates: C[]; matchedByUniqueTeams: boolean };

/**
 * Groups candidates matching the source's exact away/home team pair (never reversed — away
 * must equal away, home must equal home) into game buckets by EXACT scheduledStartAt equality
 * (regardless of bet type, so a moneyline and a spread candidate for the identical real game
 * land in the same bucket — confirmed empirically consistent within one venue, see module doc).
 * A null timestamp never merges with anything (including another null) — each forms its own
 * singleton bucket, since two unknown-timestamp candidates are not positively proven to be the
 * same game.
 *
 * ============================== TASK 12G / P1-K: SINGLETON TIME IDENTITY ==============================
 * ROOT CAUSE (Codex P1 finding): a lone bucket (only one distinct game discovered for this
 * team pair) was previously accepted as FOUND unconditionally -- "only one candidate happened
 * to be discovered" is NOT positive game-identity evidence. The same two MLB teams routinely
 * play on consecutive days; if discovery happened to return only Day 2's game while the
 * source signal is from Day 1, the team-pair-only match would silently resolve against the
 * WRONG physical game.
 *
 * FIX: a singleton bucket must now ALSO pass the exact same start-time proof multi-bucket
 * disambiguation already required -- source timestamp present, candidate timestamp present,
 * and millisecond-exact equal. No tolerance of any kind is introduced (this project's own
 * module doc already documents a real 3-hour PM-US/Kalshi cross-venue discrepancy that
 * deliberately does NOT justify one). A source or candidate timestamp that is missing, or a
 * present-but-unequal pair, now fails closed to UNVERIFIED_MISSING_START_TIME rather than a
 * false EXACT -- per the mission's explicit preference for fail-closed UNVERIFIED over a
 * silently-wrong match. Multi-bucket (genuine doubleheader-shaped) disambiguation below is
 * completely unchanged.
 * ================================================================================
 */
function groupByGame<C extends { awayTeam: string | null; homeTeam: string | null; scheduledStartAt: string | null }>(
  source: SourceSignal,
  candidates: C[],
): GameBucketResult<C> {
  const teamMatches = candidates.filter((c) => c.awayTeam === source.awayTeam && c.homeTeam === source.homeTeam);
  if (teamMatches.length === 0) return { kind: "NONE" };

  const buckets: C[][] = [];
  for (const c of teamMatches) {
    const ts = toEpochMs(c.scheduledStartAt);
    if (ts === null) {
      buckets.push([c]);
      continue;
    }
    const existing = buckets.find((b) => toEpochMs(b[0]?.scheduledStartAt ?? null) === ts);
    if (existing) existing.push(c);
    else buckets.push([c]);
  }

  if (buckets.length === 1) {
    const onlyBucket = buckets[0] ?? [];
    const bucketTs = toEpochMs(onlyBucket[0]?.scheduledStartAt ?? null);
    const sourceTs = toEpochMs(source.gameStartTime);
    if (sourceTs === null) {
      return { kind: "UNVERIFIED_MISSING_TIME", reason: "the only candidate game for this team pair cannot be confirmed: source has no start time to verify against" };
    }
    if (bucketTs === null) {
      return { kind: "UNVERIFIED_MISSING_TIME", reason: "the only candidate game for this team pair cannot be confirmed: candidate has no start time to verify against" };
    }
    if (bucketTs !== sourceTs) {
      return {
        kind: "UNVERIFIED_AMBIGUOUS",
        reason: `the only candidate game for this team pair has a start time (${onlyBucket[0]?.scheduledStartAt}) that does not exactly match the source's start time (${source.gameStartTime}) -- same-team-pair alone is not positive game identity (e.g. consecutive-day games)`,
      };
    }
    return { kind: "FOUND", candidates: onlyBucket, matchedByUniqueTeams: true };
  }

  // Multiple buckets: a doubleheader-shaped situation. Require exact timestamp equality to disambiguate.
  const sourceTs = toEpochMs(source.gameStartTime);
  if (sourceTs === null) {
    return { kind: "UNVERIFIED_AMBIGUOUS", reason: `${buckets.length} candidate games share the exact team pair and the source has no start time to disambiguate them` };
  }
  const exactBuckets = buckets.filter((b) => toEpochMs(b[0]?.scheduledStartAt ?? null) === sourceTs);
  if (exactBuckets.length !== 1) {
    return { kind: "UNVERIFIED_AMBIGUOUS", reason: `${buckets.length} candidate games share the exact team pair; ${exactBuckets.length} match the source start time exactly` };
  }
  return { kind: "FOUND", candidates: exactBuckets[0] ?? [], matchedByUniqueTeams: false };
}

/** Deduplicates by a key so a candidate list containing the exact same market twice (e.g. an overlapping discovery page) never manufactures a spurious ambiguous-target result. */
function dedupeByKey<C>(items: C[], key: (c: C) => string | null): C[] {
  const seen = new Map<string, C>();
  const noKey: C[] = [];
  for (const item of items) {
    const k = key(item);
    if (k === null) noKey.push(item);
    else seen.set(k, item);
  }
  return [...seen.values(), ...noKey];
}

/* ------------------------------- Result builders ------------------------------- */

function baseResult(venue: "PMUS" | "KALSHI", source: SourceSignal): Omit<VenueMatchResult, "status" | "reasonCode" | "reason"> {
  return {
    venue,
    sourceConditionId: source.conditionId,
    sourceMarketSlug: source.marketSlug,
    targetEventId: null,
    targetMarketId: null,
    targetFetchKey: null,
    targetGameIdentifier: null,
    targetAwayTeam: null,
    targetHomeTeam: null,
    targetBetType: null,
    sourceLine: source.line,
    targetLine: null,
    sourceStartTime: source.gameStartTime,
    targetStartTime: null,
    targetSide: null,
    targetPmusOrientation: null,
    settlementCompatibility: "UNVERIFIED",
    settlementProfile: null,
    candidateCounts: { exact: 0, near: 0, unverified: 0, total: 0 },
    evidence: [],
  };
}

function simpleResult(
  venue: "PMUS" | "KALSHI",
  source: SourceSignal,
  status: MatchStatus,
  reasonCode: ResolverReasonCode,
  reason: string,
  extra: Partial<VenueMatchResult> = {},
): VenueMatchResult {
  return { ...baseResult(venue, source), status, reasonCode, reason, ...extra };
}

/* ------------------------------- PM-US resolution ------------------------------- */

type PmusEvalOutcome = {
  status: "EXACT" | "NEAR" | "UNVERIFIED";
  candidate: PmusCandidate;
  targetSide: TargetSide | null;
  /** Task 12G / P1-J: the matched PM-US side's actual `long` flag, translated to LONG/SHORT. Never inferred from team identity, favorite/underdog, price, BUY/SELL, or the sign of a spread -- always read directly off the specific `PmusCandidateSide` the resolver matched. */
  pmusOrientation: PmusOrientation | null;
  profile: SettlementProfile | null;
  reason: string;
};

/** Task 12G / P1-J: translates a matched PmusCandidateSide's `long` flag to PmusOrientation. Returns null (never a guessed default) when `long` is null/undefined -- missing orientation data, not a boolean false. */
function sideOrientation(side: { long: boolean | null }): PmusOrientation | null {
  if (side.long === true) return "LONG";
  if (side.long === false) return "SHORT";
  return null;
}

function pmusSideTeamIdentity(side: PmusCandidate["sides"][number], league: string | null): string | null {
  const normalizeLeagueTeam = (raw: string | null | undefined): string | null => (league ? normalizeParticipantName(raw ?? null, league) : null);
  return (
    normalizeLeagueTeam(side.teamName) ??
    normalizeLeagueTeam(side.teamAbbreviation) ??
    normalizeLeagueTeam(side.description) ??
    normalizeTeamName(side.teamName ?? null) ??
    normalizeTeamName(side.teamAbbreviation ?? null) ??
    normalizeTeamName(side.description ?? null)
  );
}

function evaluatePmusCandidate(source: SourceSignal, outcome: SourceOutcome, candidate: PmusCandidate): PmusEvalOutcome | null {
  if (candidate.betType !== source.betType) return null; // not a candidate for this query at all

  if (outcome.kind === "MONEYLINE") {
    const side = candidate.sides.find((s) => pmusSideTeamIdentity(s, candidate.league) === outcome.team);
    if (!side) return { status: "UNVERIFIED", candidate, targetSide: null, pmusOrientation: null, profile: null, reason: "source team not found among PM-US market sides" };
    const orientation = sideOrientation(side);
    if (orientation === null) {
      // J9: missing/ambiguous PM-US orientation must never default LONG -- fails closed to UNVERIFIED.
      return { status: "UNVERIFIED", candidate, targetSide: null, pmusOrientation: null, profile: null, reason: "matched PM-US moneyline side has no resolvable LONG/SHORT orientation" };
    }
    const profile = buildSettlementProfile(candidate.rulesDescription, source.sourceRulesDescription, null);
    const compat = overallCompatibility(profile);
    const status = compat === "COMPATIBLE" ? "EXACT" : compat === "INCOMPATIBLE" ? "NEAR" : "UNVERIFIED";
    return { status, candidate, targetSide: { kind: "TEAM", team: outcome.team }, pmusOrientation: orientation, profile, reason: `moneyline side matched for ${outcome.team}` };
  }

  if (outcome.kind === "SPREAD") {
    // s.long === null/undefined is already excluded by this filter -- sideOrientation
    // below is therefore guaranteed non-null for any matchingSide found here.
    const matchingSide = candidate.sides.find((s) => {
      if (s.long === null || s.long === undefined || candidate.line === null) return false;
      const code = pmusSideTeamIdentity(s, candidate.league);
      if (code !== outcome.team) return false;
      const impliedLine = s.long ? candidate.line : -candidate.line;
      return Math.abs(impliedLine - outcome.line) < 1e-9;
    });
    if (matchingSide) {
      const profile = buildSettlementProfile(candidate.rulesDescription, source.sourceRulesDescription, candidate.line);
      const compat = overallCompatibility(profile);
      const status = compat === "COMPATIBLE" ? "EXACT" : compat === "INCOMPATIBLE" ? "NEAR" : "UNVERIFIED";
      return { status, candidate, targetSide: { kind: "TEAM", team: outcome.team }, pmusOrientation: sideOrientation(matchingSide), profile, reason: `spread side matched: ${outcome.team} ${outcome.line}` };
    }
    // Same game, same bet type, but this specific candidate's line/team doesn't match -> NEAR diagnostic.
    return { status: "NEAR", candidate, targetSide: null, pmusOrientation: null, profile: null, reason: `spread candidate line ${candidate.line} does not match source line ${outcome.line} for ${outcome.team}` };
  }

  // TOTAL
  if (candidate.line === null || Math.abs(candidate.line - outcome.line) > 1e-9) {
    return { status: "NEAR", candidate, targetSide: null, pmusOrientation: null, profile: null, reason: `total candidate line ${candidate.line} does not match source line ${outcome.line}` };
  }
  const directionText = outcome.direction === "OVER" ? "over" : "under";
  const side = candidate.sides.find((s) => (s.description ?? "").toLowerCase().includes(directionText));
  if (!side) return { status: "UNVERIFIED", candidate, targetSide: null, pmusOrientation: null, profile: null, reason: "over/under side not found among PM-US market sides" };
  const orientation = sideOrientation(side);
  if (orientation === null) {
    return { status: "UNVERIFIED", candidate, targetSide: null, pmusOrientation: null, profile: null, reason: "matched PM-US total side has no resolvable LONG/SHORT orientation" };
  }
  const profile = buildSettlementProfile(candidate.rulesDescription, source.sourceRulesDescription, candidate.line);
  const compat = overallCompatibility(profile);
  const status = compat === "COMPATIBLE" ? "EXACT" : compat === "INCOMPATIBLE" ? "NEAR" : "UNVERIFIED";
  return { status, candidate, targetSide: { kind: outcome.direction }, pmusOrientation: orientation, profile, reason: `total side matched: ${outcome.direction} ${outcome.line}` };
}

export function resolvePmusMatch(source: SourceSignal, candidates: PmusCandidate[]): VenueMatchResult {
  const outcome = parseSourceOutcome(source);
  if (!outcome) {
    return simpleResult("PMUS", source, "UNVERIFIED", "UNVERIFIED_SOURCE_OUTCOME", "source-selected outcome could not be parsed into a canonical form");
  }

  const eligible = candidates.filter((c) => c.status === "ELIGIBLE");
  const bucket = groupByGame(source, eligible);

  if (bucket.kind === "NONE") {
    return simpleResult("PMUS", source, "NONE", "NONE_NO_CANDIDATE", "no PM-US candidate shares the source's exact away/home team pair");
  }
  if (bucket.kind === "UNVERIFIED_AMBIGUOUS") {
    return simpleResult("PMUS", source, "UNVERIFIED", "UNVERIFIED_AMBIGUOUS_GAME", bucket.reason);
  }
  if (bucket.kind === "UNVERIFIED_MISSING_TIME") {
    return simpleResult("PMUS", source, "UNVERIFIED", "UNVERIFIED_MISSING_START_TIME", bucket.reason);
  }

  const evidence: string[] = [];
  if (!bucket.matchedByUniqueTeams) evidence.push("game disambiguated via exact start-time match among multiple same-team candidates");
  else evidence.push("game identity established via unique team-pair match (no competing candidate to disambiguate against)");

  const typeMatches = dedupeByKey(
    bucket.candidates.filter((c) => c.betType === source.betType),
    (c) => c.marketId,
  );
  if (typeMatches.length === 0) {
    return simpleResult("PMUS", source, "NONE", "NONE_NO_CANDIDATE", `no PM-US ${source.betType} candidate exists for this game`, {
      targetGameIdentifier: bucket.candidates[0]?.gameId ?? null,
      evidence,
    });
  }

  const evaluations = typeMatches.map((c) => evaluatePmusCandidate(source, outcome, c)).filter((e): e is PmusEvalOutcome => e !== null);
  const exact = evaluations.filter((e) => e.status === "EXACT");
  const near = evaluations.filter((e) => e.status === "NEAR");
  const unverified = evaluations.filter((e) => e.status === "UNVERIFIED");
  const counts = { exact: exact.length, near: near.length, unverified: unverified.length, total: evaluations.length };

  const withCounts = (r: VenueMatchResult): VenueMatchResult => ({ ...r, candidateCounts: counts, evidence: [...evidence, ...r.evidence] });

  if (exact.length === 1) {
    const e = exact[0]!;
    return withCounts(
      simpleResult("PMUS", source, "EXACT", "EXACT_MATCH", e.reason, {
        targetEventId: e.candidate.eventId,
        targetMarketId: e.candidate.marketId,
        targetFetchKey: e.candidate.marketSlug,
        targetGameIdentifier: e.candidate.gameId,
        targetAwayTeam: e.candidate.awayTeam,
        targetHomeTeam: e.candidate.homeTeam,
        targetBetType: e.candidate.betType,
        targetLine: e.candidate.line,
        targetStartTime: e.candidate.scheduledStartAt,
        targetSide: e.targetSide,
        targetPmusOrientation: e.pmusOrientation,
        settlementCompatibility: e.profile ? overallCompatibility(e.profile) : "UNVERIFIED",
        settlementProfile: e.profile,
      }),
    );
  }
  if (exact.length > 1) {
    return withCounts(simpleResult("PMUS", source, "UNVERIFIED", "UNVERIFIED_AMBIGUOUS_TARGET", `${exact.length} PM-US candidates independently qualify as EXACT`));
  }
  if (unverified.length > 0) {
    const u = unverified[0]!;
    const isRuleIssue = u.profile !== null;
    return withCounts(
      simpleResult("PMUS", source, "UNVERIFIED", isRuleIssue ? "UNVERIFIED_RULES" : "UNVERIFIED_SIDE_ORIENTATION", u.reason, {
        targetEventId: u.candidate.eventId,
        targetMarketId: u.candidate.marketId,
        targetGameIdentifier: u.candidate.gameId,
        targetAwayTeam: u.candidate.awayTeam,
        targetHomeTeam: u.candidate.homeTeam,
        targetBetType: u.candidate.betType,
        targetLine: u.candidate.line,
        targetStartTime: u.candidate.scheduledStartAt,
        settlementCompatibility: u.profile ? overallCompatibility(u.profile) : "UNVERIFIED",
        settlementProfile: u.profile,
      }),
    );
  }
  if (near.length > 0) {
    const n = near[0]!;
    const status = n.profile && overallCompatibility(n.profile) === "INCOMPATIBLE" ? "NEAR_RULE_MISMATCH" : "NEAR_DIFFERENT_LINE";
    return withCounts(
      simpleResult("PMUS", source, "NEAR", status, n.reason, {
        targetEventId: n.candidate.eventId,
        targetMarketId: n.candidate.marketId,
        targetGameIdentifier: n.candidate.gameId,
        targetAwayTeam: n.candidate.awayTeam,
        targetHomeTeam: n.candidate.homeTeam,
        targetBetType: n.candidate.betType,
        targetLine: n.candidate.line,
        targetStartTime: n.candidate.scheduledStartAt,
        settlementCompatibility: n.profile ? overallCompatibility(n.profile) : "UNVERIFIED",
        settlementProfile: n.profile,
      }),
    );
  }
  return withCounts(simpleResult("PMUS", source, "NONE", "NONE_NO_CANDIDATE", "no PM-US candidate could be evaluated"));
}

/* ------------------------------- Kalshi resolution ------------------------------- */

type KalshiEvalOutcome = { status: "EXACT" | "NEAR" | "UNVERIFIED"; candidate: KalshiCandidate; targetSide: TargetSide | null; profile: SettlementProfile | null; reason: string };

function kalshiRulesText(c: KalshiCandidate): string | null {
  const parts = [c.rulesPrimary, c.rulesSecondary].filter((t): t is string => Boolean(t));
  return parts.length > 0 ? parts.join(" ") : null;
}

function evaluateKalshiCandidate(source: SourceSignal, outcome: SourceOutcome, candidate: KalshiCandidate, side: "YES" | "NO", targetLineOverride?: number): KalshiEvalOutcome {
  const line = targetLineOverride ?? candidate.line;
  const profile = buildSettlementProfile(kalshiRulesText(candidate), source.sourceRulesDescription, outcome.kind === "MONEYLINE" ? null : line);
  const compat = overallCompatibility(profile);
  const status = compat === "COMPATIBLE" ? "EXACT" : compat === "INCOMPATIBLE" ? "NEAR" : "UNVERIFIED";
  return { status, candidate, targetSide: { kind: side }, profile, reason: `matched via ${side} side` };
}

export function resolveKalshiMatch(source: SourceSignal, candidates: KalshiCandidate[]): VenueMatchResult {
  const outcome = parseSourceOutcome(source);
  if (!outcome) {
    return simpleResult("KALSHI", source, "UNVERIFIED", "UNVERIFIED_SOURCE_OUTCOME", "source-selected outcome could not be parsed into a canonical form");
  }

  const eligible = candidates.filter((c) => c.status === "ELIGIBLE");
  const bucket = groupByGame(source, eligible);

  if (bucket.kind === "NONE") {
    return simpleResult("KALSHI", source, "NONE", "NONE_NO_CANDIDATE", "no Kalshi candidate shares the source's exact away/home team pair");
  }
  if (bucket.kind === "UNVERIFIED_AMBIGUOUS") {
    return simpleResult("KALSHI", source, "UNVERIFIED", "UNVERIFIED_AMBIGUOUS_GAME", bucket.reason);
  }
  if (bucket.kind === "UNVERIFIED_MISSING_TIME") {
    return simpleResult("KALSHI", source, "UNVERIFIED", "UNVERIFIED_MISSING_START_TIME", bucket.reason);
  }

  const evidence: string[] = [];
  if (!bucket.matchedByUniqueTeams) evidence.push("game disambiguated via exact start-time match among multiple same-team candidates");
  else evidence.push("game identity established via unique team-pair match (no competing candidate to disambiguate against)");

  const typeMatches = dedupeByKey(
    bucket.candidates.filter((c) => c.betType === source.betType),
    (c) => c.marketTicker,
  );
  if (typeMatches.length === 0) {
    return simpleResult("KALSHI", source, "NONE", "NONE_NO_CANDIDATE", `no Kalshi ${source.betType} candidate exists for this game`, {
      targetGameIdentifier: bucket.candidates[0]?.gameCode ?? null,
      evidence,
    });
  }

  let evaluations: KalshiEvalOutcome[] = [];
  const nearFallback: { candidate: KalshiCandidate; reason: string }[] = [];

  if (outcome.kind === "MONEYLINE") {
    const direct = typeMatches.find((c) => c.propositionTeam === outcome.team);
    if (direct) {
      evaluations = [evaluateKalshiCandidate(source, outcome, direct, "YES")];
    } else {
      const opponent = opponentOf(source, outcome.team);
      const complement = typeMatches.find((c) => c.propositionTeam === opponent);
      if (complement) evaluations = [evaluateKalshiCandidate(source, outcome, complement, "NO")];
      else for (const c of typeMatches) nearFallback.push({ candidate: c, reason: "no Kalshi ticker names the source team or its opponent directly" });
    }
  } else if (outcome.kind === "SPREAD") {
    const wantsDirect = outcome.line < 0;
    const propositionTeam = wantsDirect ? outcome.team : opponentOf(source, outcome.team);
    const positiveLine = Math.abs(outcome.line);
    const direct = typeMatches.find((c) => c.propositionTeam === propositionTeam && c.line !== null && Math.abs(c.line - positiveLine) < 1e-9);
    if (direct) {
      evaluations = [evaluateKalshiCandidate(source, outcome, direct, wantsDirect ? "YES" : "NO", positiveLine)];
    } else {
      for (const c of typeMatches) nearFallback.push({ candidate: c, reason: `no Kalshi spread candidate for ${propositionTeam} at line ${positiveLine} (source: ${outcome.team} ${outcome.line})` });
    }
  } else {
    const direct = typeMatches.find((c) => c.line !== null && Math.abs(c.line - outcome.line) < 1e-9);
    if (direct) {
      evaluations = [evaluateKalshiCandidate(source, outcome, direct, outcome.direction === "OVER" ? "YES" : "NO")];
    } else {
      for (const c of typeMatches) nearFallback.push({ candidate: c, reason: `total candidate line ${c.line} does not match source line ${outcome.line}` });
    }
  }

  const exact = evaluations.filter((e) => e.status === "EXACT");
  const unverifiedDirect = evaluations.filter((e) => e.status === "UNVERIFIED");
  const nearDirect = evaluations.filter((e) => e.status === "NEAR");
  const counts = { exact: exact.length, near: nearDirect.length + nearFallback.length, unverified: unverifiedDirect.length, total: typeMatches.length };
  const withCounts = (r: VenueMatchResult): VenueMatchResult => ({ ...r, candidateCounts: counts, evidence: [...evidence, ...r.evidence] });

  if (exact.length === 1) {
    const e = exact[0]!;
    return withCounts(
      simpleResult("KALSHI", source, "EXACT", "EXACT_MATCH", e.reason, {
        targetEventId: e.candidate.eventTicker,
        targetMarketId: e.candidate.marketTicker,
        targetFetchKey: e.candidate.marketTicker,
        targetGameIdentifier: e.candidate.gameCode,
        targetAwayTeam: e.candidate.awayTeam,
        targetHomeTeam: e.candidate.homeTeam,
        targetBetType: e.candidate.betType,
        targetLine: e.candidate.line,
        targetStartTime: e.candidate.scheduledStartAt,
        targetSide: e.targetSide,
        settlementCompatibility: e.profile ? overallCompatibility(e.profile) : "UNVERIFIED",
        settlementProfile: e.profile,
      }),
    );
  }
  if (exact.length > 1) {
    return withCounts(simpleResult("KALSHI", source, "UNVERIFIED", "UNVERIFIED_AMBIGUOUS_TARGET", `${exact.length} Kalshi candidates independently qualify as EXACT`));
  }
  if (unverifiedDirect.length > 0) {
    const u = unverifiedDirect[0]!;
    return withCounts(
      simpleResult("KALSHI", source, "UNVERIFIED", "UNVERIFIED_RULES", u.reason, {
        targetEventId: u.candidate.eventTicker,
        targetMarketId: u.candidate.marketTicker,
        targetGameIdentifier: u.candidate.gameCode,
        targetAwayTeam: u.candidate.awayTeam,
        targetHomeTeam: u.candidate.homeTeam,
        targetBetType: u.candidate.betType,
        targetLine: u.candidate.line,
        targetStartTime: u.candidate.scheduledStartAt,
        settlementCompatibility: overallCompatibility(u.profile!),
        settlementProfile: u.profile,
      }),
    );
  }
  if (nearDirect.length > 0) {
    const n = nearDirect[0]!;
    return withCounts(
      simpleResult("KALSHI", source, "NEAR", "NEAR_RULE_MISMATCH", n.reason, {
        targetEventId: n.candidate.eventTicker,
        targetMarketId: n.candidate.marketTicker,
        targetGameIdentifier: n.candidate.gameCode,
        targetAwayTeam: n.candidate.awayTeam,
        targetHomeTeam: n.candidate.homeTeam,
        targetBetType: n.candidate.betType,
        targetLine: n.candidate.line,
        targetStartTime: n.candidate.scheduledStartAt,
        settlementCompatibility: n.profile ? overallCompatibility(n.profile) : "UNVERIFIED",
        settlementProfile: n.profile,
      }),
    );
  }
  if (nearFallback.length > 0) {
    const n = nearFallback[0]!;
    return withCounts(
      simpleResult("KALSHI", source, "NEAR", "NEAR_DIFFERENT_LINE", n.reason, {
        targetEventId: n.candidate.eventTicker,
        targetMarketId: n.candidate.marketTicker,
        targetGameIdentifier: n.candidate.gameCode,
        targetAwayTeam: n.candidate.awayTeam,
        targetHomeTeam: n.candidate.homeTeam,
        targetBetType: n.candidate.betType,
        targetLine: n.candidate.line,
        targetStartTime: n.candidate.scheduledStartAt,
      }),
    );
  }
  return withCounts(simpleResult("KALSHI", source, "NONE", "NONE_NO_CANDIDATE", "no Kalshi candidate could be evaluated"));
}

/** Resolves both venues independently in one call. Never compares them to each other or picks a winner — that is a later task's job. */
export function resolveSportsMarket(
  source: SourceSignal,
  pmusCandidates: PmusCandidate[],
  kalshiCandidates: KalshiCandidate[],
): { pmusResult: VenueMatchResult; kalshiResult: VenueMatchResult } {
  return {
    pmusResult: resolvePmusMatch(source, pmusCandidates),
    kalshiResult: resolveKalshiMatch(source, kalshiCandidates),
  };
}

/**
 * FINAL BUILD Part 6: structured, versioned rule-fingerprint evidence for a match
 * result, persisted to sports_market_matches.rule_fingerprint so an EXACT match
 * remains independently auditable later without re-deriving it from
 * candidateCounts/evidence prose. Every dimension the mission's own Part 6 checklist
 * names is represented explicitly (never merged into one boolean) so a later audit can
 * see EXACTLY which dimension made a match NEAR/UNVERIFIED rather than EXACT.
 *
 * Deliberately built from the SAME VenueMatchResult fields resolvePmusMatch/
 * resolveKalshiMatch already compute -- this is a presentation/persistence layer over
 * existing evidence, not a new matching algorithm. If resolver.ts's matching logic
 * changes materially, bump RULE_FINGERPRINT_VERSION in epoch.ts (RESOLVER_VERSION),
 * not this function alone -- the fingerprint's SHAPE can change freely without forcing
 * a new epoch as long as the underlying matching semantics did not change; a semantics
 * change always forces one regardless of whether this function's output shape moved.
 */
/** Bump whenever buildRuleFingerprint's SHAPE changes in a way that would break a consumer parsing the persisted jsonb -- kept independent of epoch.ts's RESOLVER_VERSION (which tracks matching SEMANTICS, not this function's output shape) to avoid a resolver.ts <-> epoch.ts import cycle. */
export const RESOLVER_RULE_FINGERPRINT_VERSION = "rule_fingerprint_v1";

export type RuleFingerprint = {
  teams: { away: string | null; home: string | null };
  gameIdentity: { targetGameIdentifier: string | null; targetStartTime: string | null; sourceStartTime: string | null };
  marketType: BetType | null;
  line: { source: number | null; target: number | null };
  selectedSide: TargetSide | null;
  pmusOrientation: PmusOrientation | null;
  fullGameScope: true; // Phase 1 is full-game-only by construction (eligibility.ts) -- always true, never a derivative/period market.
  settlement: {
    compatibility: SettlementCompatibility;
    extraInnings: RuleDimensionStatus | null;
    postponement: RuleDimensionStatus | null;
    pushRisk: RuleDimensionStatus | null;
  };
};

export function buildRuleFingerprint(result: VenueMatchResult): RuleFingerprint {
  return {
    teams: { away: result.targetAwayTeam, home: result.targetHomeTeam },
    gameIdentity: {
      targetGameIdentifier: result.targetGameIdentifier,
      targetStartTime: result.targetStartTime,
      sourceStartTime: result.sourceStartTime,
    },
    marketType: result.targetBetType,
    line: { source: result.sourceLine, target: result.targetLine },
    selectedSide: result.targetSide,
    pmusOrientation: result.targetPmusOrientation,
    fullGameScope: true,
    settlement: {
      compatibility: result.settlementCompatibility,
      extraInnings: result.settlementProfile?.extraInnings ?? null,
      postponement: result.settlementProfile?.postponement ?? null,
      pushRisk: result.settlementProfile?.pushRisk ?? null,
    },
  };
}
