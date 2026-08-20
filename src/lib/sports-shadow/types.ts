export type BetType = "MONEYLINE" | "SPREAD" | "TOTAL";
export type Venue = "PMUS" | "KALSHI";
export type MatchStatus = "EXACT" | "NEAR" | "NONE" | "UNVERIFIED";
export type SettlementCompatibility = "COMPATIBLE" | "INCOMPATIBLE" | "UNVERIFIED";

/** Three-way source-eligibility classification (Task 3). Never collapse UNVERIFIED into INELIGIBLE. */
export type ClassificationStatus = "ELIGIBLE" | "INELIGIBLE" | "UNVERIFIED";

/** Structured source-market metadata resolved from gamma-api by conditionId (Task 3). */
export type SourceMarketMetadata = {
  conditionId: string;
  league: string | null;
  sportsMarketType: string | null;
  betType: BetType | null;
  /** ELIGIBLE / INELIGIBLE / UNVERIFIED — see src/lib/sports-shadow/eligibility.ts for the full reason-code vocabulary. */
  status: ClassificationStatus;
  /** One of the ReasonCode values from eligibility.ts, kept as `string` here to avoid a circular import. */
  reasonCode: string;
  ineligibleReason: string | null;
  line: number | null;
  awayTeam: string | null;
  homeTeam: string | null;
  gameStartTime: string | null;
  sourceGameId: string | null;
  eventSlug: string | null;
  marketSlug: string | null;
};

/** One resolvable target contract candidate, shape-normalized across venues (Task 5/6). */
export type TargetCandidate = {
  venue: Venue;
  eventId: string;
  marketId: string;
  betType: BetType;
  awayTeam: string;
  homeTeam: string;
  gameStartTime: string | null;
  line: number | null;
  /** Which side this specific contract's price/quote refers to: a team code, "OVER", or "UNDER". */
  selectedSide: string;
  marketStatus: string | null;
  bestBid: number | null;
  bestAsk: number | null;
};

export type DepthLevel = { price: number; size: number };

export type BookSnapshot = {
  venue: Venue;
  marketId: string;
  bestBid: number | null;
  bestAsk: number | null;
  bidLevels: DepthLevel[];
  askLevels: DepthLevel[];
  marketStatus: string | null;
  observedAt: number;
  staleReason: string | null;
};
