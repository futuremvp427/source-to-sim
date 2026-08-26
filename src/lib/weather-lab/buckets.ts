/**
 * Kalshi daily-high bucket parsing and event-structure validation.
 *
 * A daily-high event is a set of markets over the same station-day. The
 * probability engine can only emit a valid distribution if that set is
 * genuinely exhaustive and mutually exclusive, so this module refuses to
 * describe an event it cannot prove is well formed.
 *
 * Observed Kalshi strike shapes on KXHIGH* series:
 *   strike_type "less"    + cap_strike C    -> temperature <= C - 1  ("C-1 or below")
 *   strike_type "between" + floor F, cap C  -> F <= temperature <= C
 *   strike_type "greater" + floor_strike F  -> temperature >= F + 1  ("F+1 or above")
 *
 * The `less`/`greater` off-by-one is real and load bearing: KXHIGHNY-26AUG27-T80
 * carries cap_strike 80 and reads "79 or below". Getting this wrong silently
 * shifts every bucket and every probability by one degree.
 */

export type RawKalshiMarket = {
  ticker: string;
  strike_type?: string | null;
  floor_strike?: number | null;
  cap_strike?: number | null;
  yes_sub_title?: string | null;
  subtitle?: string | null;
};

export type TemperatureBucket = {
  ticker: string;
  /** Inclusive lower bound in whole degrees F; null means unbounded below. */
  lowerF: number | null;
  /** Inclusive upper bound in whole degrees F; null means unbounded above. */
  upperF: number | null;
  label: string;
};

export type BucketSetValidation =
  | { status: "VALID"; buckets: TemperatureBucket[] }
  | { status: "INVALID"; reason: string; buckets: TemperatureBucket[] };

export class BucketParseError extends Error {
  constructor(ticker: string, reason: string) {
    super(`Cannot parse bucket for ${ticker}: ${reason}`);
    this.name = "BucketParseError";
  }
}

function isInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

/** Parse one market into an inclusive integer-degree interval. Fails closed. */
export function parseBucket(market: RawKalshiMarket): TemperatureBucket {
  const label = market.yes_sub_title ?? market.subtitle ?? market.ticker;
  const strike = market.strike_type ?? null;

  switch (strike) {
    case "less": {
      if (!isInteger(market.cap_strike)) {
        throw new BucketParseError(market.ticker, "strike_type 'less' requires an integer cap_strike");
      }
      return { ticker: market.ticker, lowerF: null, upperF: market.cap_strike - 1, label };
    }
    case "greater": {
      if (!isInteger(market.floor_strike)) {
        throw new BucketParseError(market.ticker, "strike_type 'greater' requires an integer floor_strike");
      }
      return { ticker: market.ticker, lowerF: market.floor_strike + 1, upperF: null, label };
    }
    case "between": {
      if (!isInteger(market.floor_strike) || !isInteger(market.cap_strike)) {
        throw new BucketParseError(
          market.ticker,
          "strike_type 'between' requires integer floor_strike and cap_strike",
        );
      }
      if (market.cap_strike < market.floor_strike) {
        throw new BucketParseError(market.ticker, "cap_strike is below floor_strike");
      }
      return { ticker: market.ticker, lowerF: market.floor_strike, upperF: market.cap_strike, label };
    }
    default:
      throw new BucketParseError(market.ticker, `unrecognised strike_type ${JSON.stringify(strike)}`);
  }
}

/**
 * Validate that a parsed set tiles the whole integer temperature line exactly
 * once: exactly one unbounded-below bucket, exactly one unbounded-above bucket,
 * and no gap or overlap anywhere in between.
 */
export function validateBucketSet(buckets: readonly TemperatureBucket[]): BucketSetValidation {
  const sorted = [...buckets].sort((a, b) => {
    if (a.lowerF === null) return -1;
    if (b.lowerF === null) return 1;
    return a.lowerF - b.lowerF;
  });

  if (sorted.length < 2) {
    return { status: "INVALID", reason: "an exhaustive event needs at least two buckets", buckets: sorted };
  }

  const unboundedBelow = sorted.filter((b) => b.lowerF === null);
  const unboundedAbove = sorted.filter((b) => b.upperF === null);
  if (unboundedBelow.length !== 1) {
    return {
      status: "INVALID",
      reason: `expected exactly one unbounded-below bucket, found ${unboundedBelow.length}`,
      buckets: sorted,
    };
  }
  if (unboundedAbove.length !== 1) {
    return {
      status: "INVALID",
      reason: `expected exactly one unbounded-above bucket, found ${unboundedAbove.length}`,
      buckets: sorted,
    };
  }
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) {
    return { status: "INVALID", reason: "bucket set is empty after sorting", buckets: sorted };
  }
  if (first.lowerF !== null) {
    return { status: "INVALID", reason: "lowest bucket must be unbounded below", buckets: sorted };
  }
  if (last.upperF !== null) {
    return { status: "INVALID", reason: "highest bucket must be unbounded above", buckets: sorted };
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    if (prev.upperF === null) {
      return { status: "INVALID", reason: `${prev.ticker} is unbounded above but is not the last bucket`, buckets: sorted };
    }
    if (cur.lowerF === null) {
      return { status: "INVALID", reason: `${cur.ticker} is unbounded below but is not the first bucket`, buckets: sorted };
    }
    if (cur.lowerF <= prev.upperF) {
      return {
        status: "INVALID",
        reason: `overlap between ${prev.ticker} (..${prev.upperF}) and ${cur.ticker} (${cur.lowerF}..)`,
        buckets: sorted,
      };
    }
    if (cur.lowerF !== prev.upperF + 1) {
      return {
        status: "INVALID",
        reason: `gap between ${prev.ticker} (..${prev.upperF}) and ${cur.ticker} (${cur.lowerF}..)`,
        buckets: sorted,
      };
    }
  }

  return { status: "VALID", buckets: sorted };
}

/** True when an observed whole-degree maximum settles this bucket YES. */
export function bucketContains(bucket: TemperatureBucket, temperatureF: number): boolean {
  if (bucket.lowerF !== null && temperatureF < bucket.lowerF) return false;
  if (bucket.upperF !== null && temperatureF > bucket.upperF) return false;
  return true;
}

/** The single bucket a settled temperature resolves YES, or null if malformed. */
export function resolveBucket(
  buckets: readonly TemperatureBucket[],
  temperatureF: number,
): TemperatureBucket | null {
  const hits = buckets.filter((b) => bucketContains(b, temperatureF));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}
