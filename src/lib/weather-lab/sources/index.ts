/**
 * Weather data adapters.
 *
 * Every adapter returns `ProvenancedDatum`s so the no-lookahead layer can
 * police them. Adapters never invent a value: if a feed is unavailable the
 * adapter returns nothing and the model run records a rejected source, so a
 * thin run is visibly thin rather than silently confident.
 *
 * PROVENANCE LIMITATION, recorded deliberately rather than papered over:
 * Open-Meteo does not return the originating model run time. For **forward**
 * collection we set `issuedAt = retrievedAt`, which is sound because a forecast
 * retrieved at time T was necessarily issued at or before T, and we only ever
 * call the API at decision time. That substitution is **not** sufficient for
 * historical backtesting, where the true run time matters. Any historical
 * replay must source run times from a feed that publishes them (e.g. the NOAA
 * NBM text archive) rather than reusing this adapter.
 */

import type { ProvenancedDatum, SourceKind } from "../provenance";

export type StationSite = {
  city: string;
  /** Settlement station identifier, e.g. "CLINYC". */
  station: string;
  /** Observation station for METAR/NWS, e.g. "KNYC". */
  observationStation: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

/** Sites are enabled one at a time, after individual audit. */
export const SITES: Readonly<Record<string, StationSite>> = Object.freeze({
  NYC: { city: "NYC", station: "CLINYC", observationStation: "KNYC", latitude: 40.7794, longitude: -73.9692, timezone: "America/New_York" },
  Chicago: { city: "Chicago", station: "CLICHI", observationStation: "KORD", latitude: 41.9803, longitude: -87.9090, timezone: "America/Chicago" },
  LosAngeles: { city: "LosAngeles", station: "CLILAX", observationStation: "KLAX", latitude: 33.9382, longitude: -118.3866, timezone: "America/Los_Angeles" },
  SanFrancisco: { city: "SanFrancisco", station: "CLISFO", observationStation: "KSFO", latitude: 37.6197, longitude: -122.3647, timezone: "America/Los_Angeles" },
  Miami: { city: "Miami", station: "CLIMIA", observationStation: "KMIA", latitude: 25.7906, longitude: -80.3164, timezone: "America/New_York" },
});

export type TemperatureForecastDatum = {
  /** Forecast daily maximum in degrees F. */
  maxF: number;
  /** Empirical spread when the source is an ensemble; null otherwise. */
  spreadF: number | null;
  /** Ensemble member count, when applicable. */
  memberCount: number | null;
};

export type ObservationDatum = {
  /** Highest temperature observed so far in the settlement window, degrees F. */
  observedMaxF: number;
  observationCount: number;
};

export type FetchOutcome<T> =
  | { ok: true; datum: ProvenancedDatum<T> }
  | { ok: false; sourceId: string; source: SourceKind; reason: string };

const celsiusToF = (c: number): number => (c * 9) / 5 + 32;

async function getJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "source-to-sim-weather-lab/1.0 (research; paper only)" },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The local calendar date currently in force at a site. */
export function localDateFor(site: StationSite, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: site.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Whether an observed maximum may be used as a distribution floor for an event.
 *
 * Only the event whose settlement window is running right now can be floored by
 * today's observations. Applying today's observed maximum to a next-day event
 * would both distort that event's distribution and mislabel it as an intraday
 * observation edge, which is the opposite of the mechanism being tested.
 */
export function observationFloorApplies(site: StationSite, weatherDate: string, now: Date): boolean {
  return weatherDate === localDateFor(site, now);
}

/**
 * Highest temperature observed so far today at the site's observation station.
 *
 * This is the observation floor that drives INTRADAY_OBSERVATION_EDGE. It is
 * NOT the settlement value: settlement comes from The Weather Company, and this
 * is NWS station data, so it is used to constrain the forecast distribution and
 * never to declare an outcome.
 */
export async function fetchObservedMax(
  site: StationSite,
  now: Date,
): Promise<FetchOutcome<ObservationDatum>> {
  const sourceId = `api.weather.gov/stations/${site.observationStation}`;
  try {
    const localDate = localDateFor(site, now);
    // Window start = local midnight, expressed as an instant.
    const startLocal = new Date(`${localDate}T00:00:00`);
    const offsetProbe = new Intl.DateTimeFormat("en-US", { timeZone: site.timezone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value;
    const offset = offsetProbe?.replace("GMT", "") || "+00:00";
    const startIso = new Date(`${localDate}T00:00:00${offset}`).toISOString();
    void startLocal;

    const raw = (await getJson(
      `https://api.weather.gov/stations/${site.observationStation}/observations?start=${encodeURIComponent(startIso)}&limit=200`,
    )) as { features?: Array<{ properties?: { timestamp?: string; temperature?: { value?: number | null; unitCode?: string } } }> };

    const readings = (raw.features ?? [])
      .map((f) => {
        const t = f.properties?.temperature;
        const ts = f.properties?.timestamp;
        if (!t || t.value === null || t.value === undefined || !ts) return null;
        const valueF = t.unitCode?.includes("degF") ? t.value : celsiusToF(t.value);
        return { at: new Date(ts), valueF };
      })
      .filter((r): r is { at: Date; valueF: number } => r !== null && Number.isFinite(r.valueF))
      // Never admit an observation stamped after the decision instant.
      .filter((r) => r.at.getTime() <= now.getTime());

    if (readings.length === 0) {
      return { ok: false, sourceId, source: "STATION_OBSERVATION", reason: "no admissible observations in window" };
    }

    const observedMaxF = Math.max(...readings.map((r) => r.valueF));
    const latest = readings.reduce((a, b) => (b.at > a.at ? b : a));

    return {
      ok: true,
      datum: {
        source: "STATION_OBSERVATION",
        sourceId,
        issuedAt: latest.at,
        validAt: latest.at,
        retrievedAt: now,
        value: { observedMaxF, observationCount: readings.length },
      },
    };
  } catch (e) {
    return { ok: false, sourceId, source: "STATION_OBSERVATION", reason: (e as Error).message };
  }
}

const DETERMINISTIC_MODELS: ReadonlyArray<{ model: string; source: SourceKind }> = Object.freeze([
  { model: "gfs_seamless", source: "GFS" },
  { model: "ecmwf_ifs025", source: "ECMWF_DERIVED" },
  { model: "icon_seamless", source: "GFS" },
]);

/**
 * Deterministic multi-model daily maxima.
 *
 * `issuedAt` is set to `retrievedAt` — see the provenance limitation at the top
 * of this file. Valid for forward collection only.
 */
export async function fetchDeterministicForecasts(
  site: StationSite,
  targetLocalDate: string,
  now: Date,
): Promise<Array<FetchOutcome<TemperatureForecastDatum>>> {
  const models = DETERMINISTIC_MODELS.map((m) => m.model).join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${site.latitude}&longitude=${site.longitude}` +
    `&daily=temperature_2m_max&models=${models}&temperature_unit=fahrenheit` +
    `&timezone=${encodeURIComponent(site.timezone)}&forecast_days=3`;

  try {
    const raw = (await getJson(url)) as { daily?: Record<string, unknown> };
    const daily = raw.daily ?? {};
    const times = (daily["time"] as string[] | undefined) ?? [];
    const idx = times.indexOf(targetLocalDate);
    if (idx < 0) {
      return DETERMINISTIC_MODELS.map((m) => ({
        ok: false as const,
        sourceId: `open-meteo/${m.model}`,
        source: m.source,
        reason: `target date ${targetLocalDate} not present in forecast`,
      }));
    }

    return DETERMINISTIC_MODELS.map((m) => {
      const series = daily[`temperature_2m_max_${m.model}`] as Array<number | null> | undefined;
      const value = series?.[idx];
      if (value === null || value === undefined || !Number.isFinite(value)) {
        return { ok: false as const, sourceId: `open-meteo/${m.model}`, source: m.source, reason: "model returned no value" };
      }
      return {
        ok: true as const,
        datum: {
          source: m.source,
          sourceId: `open-meteo/${m.model}`,
          issuedAt: now,
          validAt: new Date(`${targetLocalDate}T23:59:59Z`),
          retrievedAt: now,
          value: { maxF: value, spreadF: null, memberCount: null },
        },
      };
    });
  } catch (e) {
    return DETERMINISTIC_MODELS.map((m) => ({
      ok: false as const,
      sourceId: `open-meteo/${m.model}`,
      source: m.source,
      reason: (e as Error).message,
    }));
  }
}

/**
 * GEFS ensemble daily maximum, returning the member spread.
 *
 * The empirical member spread is the honest source of forecast uncertainty; a
 * hard-coded sigma would be a tuned parameter in disguise.
 */
export async function fetchEnsembleForecast(
  site: StationSite,
  targetLocalDate: string,
  now: Date,
): Promise<FetchOutcome<TemperatureForecastDatum>> {
  const sourceId = "open-meteo-ensemble/gfs025";
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${site.latitude}&longitude=${site.longitude}` +
    `&daily=temperature_2m_max&models=gfs025&temperature_unit=fahrenheit` +
    `&timezone=${encodeURIComponent(site.timezone)}&forecast_days=3`;

  try {
    const raw = (await getJson(url)) as { daily?: Record<string, unknown> };
    const daily = raw.daily ?? {};
    const times = (daily["time"] as string[] | undefined) ?? [];
    const idx = times.indexOf(targetLocalDate);
    if (idx < 0) return { ok: false, sourceId, source: "GEFS", reason: `target date ${targetLocalDate} not present` };

    const members = Object.keys(daily)
      .filter((k) => k.startsWith("temperature_2m_max"))
      .map((k) => (daily[k] as Array<number | null> | undefined)?.[idx])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

    if (members.length < 2) return { ok: false, sourceId, source: "GEFS", reason: "insufficient ensemble members" };

    const mean = members.reduce((a, b) => a + b, 0) / members.length;
    const variance = members.reduce((a, b) => a + (b - mean) ** 2, 0) / (members.length - 1);

    return {
      ok: true,
      datum: {
        source: "GEFS",
        sourceId,
        issuedAt: now,
        validAt: new Date(`${targetLocalDate}T23:59:59Z`),
        retrievedAt: now,
        value: { maxF: mean, spreadF: Math.sqrt(variance), memberCount: members.length },
      },
    };
  } catch (e) {
    return { ok: false, sourceId, source: "GEFS", reason: (e as Error).message };
  }
}

/**
 * Forecast sigma for a deterministic model.
 *
 * Prefers the ensemble's own empirical spread. Falls back to a documented
 * lead-time table only when no ensemble is available, and the caller records
 * that the fallback was used so a run built on it is identifiable.
 */
export function forecastSigmaF(params: {
  ensembleSpreadF: number | null;
  hoursToWindowClose: number;
}): { sigmaF: number; basis: "ENSEMBLE_SPREAD" | "LEAD_TIME_FALLBACK" } {
  const { ensembleSpreadF, hoursToWindowClose } = params;
  if (ensembleSpreadF !== null && Number.isFinite(ensembleSpreadF) && ensembleSpreadF > 0.1) {
    return { sigmaF: ensembleSpreadF, basis: "ENSEMBLE_SPREAD" };
  }
  const h = Math.max(0, hoursToWindowClose);
  const sigmaF = h <= 3 ? 1.0 : h <= 8 ? 1.8 : h <= 18 ? 2.6 : h <= 36 ? 3.4 : 4.2;
  return { sigmaF, basis: "LEAD_TIME_FALLBACK" };
}
