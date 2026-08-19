/**
 * SERVER-ONLY fetch wrapper for Open-Meteo's Historical Forecast API.
 *
 * ****************************************************************
 * NOT VALIDATED AGAINST A LIVE ENDPOINT IN THIS ENVIRONMENT.
 * ****************************************************************
 * This session's outbound network access is blocked to all external hosts
 * (confirmed: archive-api.open-meteo.com, api.weather.gov, and
 * mesonet.agron.iastate.edu all returned the same egress-proxy 403 seen for
 * polymarket.com/supabase.co in prior phases). The request shape below is
 * built from Open-Meteo's public documentation and general knowledge, NOT
 * from a live response inspected in this session. Before this module is
 * trusted for a real Part 2 run, a human (or a session with network access)
 * must:
 *   1. Confirm historical-forecast-api.open-meteo.com actually serves
 *      point-in-time archived MODEL RUNS (what a forecast consumer could
 *      have known as of a past date), not a reanalysis product like ERA5
 *      (archive-api.open-meteo.com) which reflects post-hoc "best estimate
 *      of what actually happened" and would be lookahead if used here.
 *   2. Confirm the exact response fields for run/issue timestamps so
 *      `isForecastEligibleForTrade` (see open-meteo-baseline.ts) receives a
 *      genuine issue time, not a placeholder.
 *   3. Confirm ensemble member availability (this module requests
 *      `models=best_match` by default; a true multi-model ensemble spread,
 *      if available, would be a better probability estimate than a single
 *      deterministic run).
 *
 * Until that validation happens, treat any output of this module as
 * UNVERIFIED and do not present it as ground truth in a Phase 0B report.
 */

import { isForecastEligibleForTrade } from "./open-meteo-baseline";

const HISTORICAL_FORECAST_BASE = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 15_000;

export type ForecastSample = {
  /** Unix seconds: when this forecast run was issued/available (best-effort; see module doc comment). */
  issuedAtSourceTs: number;
  /** Forecasted daily max temperature in Celsius (Open-Meteo's native unit for this field). */
  temperatureMaxC: number;
};

export type FetchHistoricalForecastInput = {
  lat: number;
  lon: number;
  /** ISO date (YYYY-MM-DD) the forecast targets. */
  targetDate: string;
  /** The wallet trade's timestamp -- used only for the no-lookahead guard below, never sent upstream. */
  tradeSourceTs: number;
};

export type FetchHistoricalForecastResult =
  { ok: true; sample: ForecastSample } | { ok: false; reason: string };

/**
 * Fetches ONE point-in-time forecast sample for a city/date, then applies
 * the no-lookahead guard before returning it as usable. Returns ok:false
 * (never throws for expected failure modes) when the forecast cannot be
 * confirmed eligible, is unavailable, or the request fails -- the caller
 * (phase0b.server.ts) must exclude the trade from the sample rather than
 * substitute a guess.
 */
export async function fetchHistoricalForecast(
  input: FetchHistoricalForecastInput,
): Promise<FetchHistoricalForecastResult> {
  const url = new URL(HISTORICAL_FORECAST_BASE);
  url.searchParams.set("latitude", String(input.lat));
  url.searchParams.set("longitude", String(input.lon));
  url.searchParams.set("start_date", input.targetDate);
  url.searchParams.set("end_date", input.targetDate);
  url.searchParams.set("daily", "temperature_2m_max");
  url.searchParams.set("models", "best_match");
  url.searchParams.set("timezone", "UTC");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let json: unknown;
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `Open-Meteo request failed (HTTP ${res.status}).` };
    json = await res.json();
  } catch (err) {
    return {
      ok: false,
      reason: `Open-Meteo request error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed = json as {
    daily?: { time?: string[]; temperature_2m_max?: number[] };
    // NOT CONFIRMED: no live response has been inspected to verify Open-Meteo
    // exposes a run/issue timestamp field on this endpoint. Absent that,
    // this wrapper cannot itself prove no-lookahead -- see reason below.
    generationtime_ms?: number;
  };
  const values = parsed.daily?.temperature_2m_max;
  if (!values || values.length === 0 || values[0] === undefined || !Number.isFinite(values[0])) {
    return {
      ok: false,
      reason: "Open-Meteo returned no usable temperature_2m_max value for this date.",
    };
  }

  // UNVERIFIED PLACEHOLDER: without a confirmed issue-timestamp field (see
  // module doc comment, item 2), the only defensible no-lookahead posture is
  // to treat the forecast as issued no earlier than the start of the
  // target date it describes -- i.e. reject any trade that occurred before
  // the target date even began, since a same-day-or-later forecast run
  // could not have existed yet. This is intentionally conservative (it will
  // reject legitimately-eligible earlier forecast runs, undercounting
  // eligible trades) rather than optimistic (which could admit a lookahead
  // violation). It is NOT a substitute for confirming a real issue
  // timestamp from the API.
  const targetDateStartTs = Math.floor(Date.parse(`${input.targetDate}T00:00:00Z`) / 1000);
  if (!Number.isFinite(targetDateStartTs)) {
    return { ok: false, reason: "Could not parse target date." };
  }
  if (!isForecastEligibleForTrade(targetDateStartTs, input.tradeSourceTs)) {
    return {
      ok: false,
      reason:
        "Trade occurred at or before the target date's own start -- cannot confirm any forecast run for " +
        "that date existed yet (no-lookahead guard; see UNVERIFIED PLACEHOLDER note in this function).",
    };
  }

  return {
    ok: true,
    sample: { issuedAtSourceTs: targetDateStartTs, temperatureMaxC: values[0] },
  };
}
