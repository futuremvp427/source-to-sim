/**
 * Pure decision logic for the autonomous compatibility automation.
 *
 * Kept dependency-free so every rule below is directly unit-testable:
 * which US markets count as weather-relevant, when a stale compatibility
 * result must be re-checked, and whether a preview may be generated.
 */

export type CompatibilityStatus =
  | "EXACT_MATCH"
  | "POSSIBLE_MATCH"
  | "AMBIGUOUS"
  | "NO_MATCH";

/** Relevant category/title terms for the periodic availability scan. */
export const WEATHER_TERMS = Object.freeze([
  "weather",
  "temperature",
  "temp ",
  "rain",
  "rainfall",
  "snow",
  "snowfall",
  "hurricane",
  "tropical storm",
  "tornado",
  "climate",
  "precipitation",
  "heat wave",
  "heatwave",
  "degrees",
  "fahrenheit",
  "celsius",
]);

/** True when an open US market looks like a weather/climate market. */
export function isRelevantWeatherMarket(market: {
  question?: string | undefined;
  slug?: string | undefined;
  category?: string | null | undefined;
  subcategory?: string | null | undefined;
}): boolean {
  const haystack = ` ${[market.question, market.slug?.replace(/-/g, " "), market.category, market.subcategory]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()} `;
  return WEATHER_TERMS.some((term) => haystack.includes(term));
}

/** Minimum spacing between availability scans. */
export const SCAN_INTERVAL_MS = 15 * 60 * 1000;

export function shouldRunAvailabilityScan(
  lastScanAt: string | null,
  now: number = Date.now(),
): boolean {
  if (!lastScanAt) return true;
  const at = new Date(lastScanAt).getTime();
  if (!Number.isFinite(at)) return true;
  return now - at >= SCAN_INTERVAL_MS;
}

/** A cached non-match result is trusted for this long absent new US markets. */
export const COMPAT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A previously unresolved source market is re-checked when the cache expired
 * or when new relevant US markets appeared after the last check.
 */
export function shouldRecheckCompatibility(
  cached: { compatibility_status: string; checked_at: string } | null,
  opts: { newMarketsAt?: string | null | undefined; now?: number | undefined } = {},
): boolean {
  if (!cached) return true;
  if (cached.compatibility_status === "EXACT_MATCH") return false;
  const now = opts.now ?? Date.now();
  const checkedAt = new Date(cached.checked_at).getTime();
  if (!Number.isFinite(checkedAt)) return true;
  if (opts.newMarketsAt) {
    const newAt = new Date(opts.newMarketsAt).getTime();
    if (Number.isFinite(newAt) && newAt > checkedAt) return true;
  }
  return now - checkedAt >= COMPAT_CACHE_TTL_MS;
}

export type PreviewAction = "PREVIEW" | "NOT_ELIGIBLE" | "SKIP_EXISTING";

/**
 * Single gate in front of the authenticated order-preview call.
 *
 * - Only EXACT_MATCH with a US slug and a mapped YES/NO side may preview.
 * - A preview already pending or already decided is never regenerated, so a
 *   repeated scan cannot duplicate an approval-queue entry.
 */
export function decidePreviewAction(input: {
  compatibility: string;
  usMarketSlug: string | null;
  outcomeSide: string | null;
  existingStatus: string | null;
}): PreviewAction {
  const terminal = new Set([
    "PENDING_APPROVAL",
    "USER_APPROVED",
    "READY_FOR_MANUAL_EXECUTION",
    "REJECTED",
  ]);
  if (input.existingStatus && terminal.has(input.existingStatus)) return "SKIP_EXISTING";
  if (input.compatibility !== "EXACT_MATCH") return "NOT_ELIGIBLE";
  if (!input.usMarketSlug || !input.outcomeSide) return "NOT_ELIGIBLE";
  return "PREVIEW";
}

export function availabilityMessage(count: number): string {
  return count === 0
    ? "No compatible Polymarket US weather markets currently available. Mirror Trader continues monitoring automatically."
    : `${count} potentially relevant Polymarket US weather market${count === 1 ? "" : "s"} available.`;
}
