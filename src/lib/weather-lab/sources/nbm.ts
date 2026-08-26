/**
 * NOAA/NCEP National Blend of Models (NBM) station text bulletin parser.
 *
 * Why this exists: the first live run of the Weather Lab differenced an NWS
 * station observation against a gridded Open-Meteo forecast. On 2026-08-26 KNYC
 * ran 7-10F cooler than that grid point while the grid sat on its own forecast,
 * manufacturing a ~6.5F "cold anomaly" and a 90.8% probability on a bucket the
 * market priced at 14c. Station-basis guidance is the fix.
 *
 * IMPORTANT CAVEAT, enforced rather than assumed: NOAA generates these station
 * bulletins from the closest usable NBM grid point. A station-ID match is
 * therefore NOT automatically an observation-basis match. This module only
 * parses; `basis.ts` quantifies the residual against real observations and the
 * gate refuses to trade a station whose basis is unverified.
 *
 * Products:
 *   NBH - hourly guidance, ~25 hours, no FHR row (first column is FHR 1)
 *   NBS - short-range guidance, 3-hourly to 72 hours, explicit FHR row,
 *         plus TXN (daytime max / nighttime min) and XND (its std deviation)
 *
 * Fixed-width layout: a 4-character row label, then 3-character right-aligned
 * value fields beginning at column 5.
 */

export type NbmProduct = "NBH" | "NBS";

export type NbmStationForecast = {
  station: string;
  /** Verbatim, e.g. "V5.0". Pinned into provenance so a version change is visible. */
  version: string;
  product: NbmProduct;
  /** Model cycle (issue) time, UTC. */
  cycleTime: Date;
  /** Forecast hours, one per column. */
  forecastHours: number[];
  /** Absolute valid times, one per column. */
  validTimes: Date[];
  /** Raw numeric rows keyed by label (TMP, TSD, DPT, SKY, WDR, TXN, XND, ...). */
  rows: Record<string, Array<number | null>>;
  /** The bulletin's own header line, retained as raw-source provenance. */
  rawHeader: string;
};

export class NbmParseError extends Error {
  constructor(message: string) {
    super(`NBM parse error: ${message}`);
    this.name = "NbmParseError";
  }
}

const HEADER_RE =
  /^\s*(\S+)\s+NBM\s+(V\S+)\s+(NBH|NBS|NBP|NBE|NBX)\s+GUIDANCE\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{4})\s+UTC\s*$/;

/** Split a fixed-width bulletin row into its 3-character value fields. */
export function parseRowValues(line: string): Array<number | null> {
  const body = line.slice(5);
  const out: Array<number | null> = [];
  for (let i = 0; i + 3 <= body.length; i += 3) {
    const cell = body.slice(i, i + 3).trim();
    if (cell === "") out.push(null);
    else {
      const n = Number(cell);
      out.push(Number.isFinite(n) ? n : null);
    }
  }
  return out;
}

function rowLabel(line: string): string {
  return line.slice(0, 5).trim();
}

/**
 * Parse one station block.
 *
 * Valid times are derived from the cycle time and the forecast hour, then
 * cross-checked against the bulletin's own printed UTC labels. A disagreement
 * means our understanding of the format is wrong, so it throws rather than
 * silently producing forecasts stamped with the wrong time.
 */
export function parseStationBlock(lines: readonly string[]): NbmStationForecast {
  const header = lines[0] ?? "";
  const m = HEADER_RE.exec(header);
  if (!m) throw new NbmParseError(`unrecognised header: ${JSON.stringify(header.slice(0, 80))}`);

  const [, station, version, product, month, day, year, hhmm] = m;
  if (product !== "NBH" && product !== "NBS") {
    throw new NbmParseError(`unsupported product ${product} (only NBH and NBS are used intraday)`);
  }

  const cycleTime = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hhmm!.slice(0, 2)), Number(hhmm!.slice(2))),
  );
  if (!Number.isFinite(cycleTime.getTime())) throw new NbmParseError(`invalid cycle time in header ${header}`);

  const rows: Record<string, Array<number | null>> = {};
  let utcLabels: Array<number | null> = [];
  let fhrRow: Array<number | null> | null = null;

  for (const line of lines.slice(1)) {
    const label = rowLabel(line);
    if (!label) continue;
    const values = parseRowValues(line);
    if (label === "UTC") utcLabels = values;
    else if (label === "FHR") fhrRow = values;
    else if (label === "DT") continue;
    else rows[label] = values;
  }

  if (utcLabels.length === 0) throw new NbmParseError(`station ${station} has no UTC row`);

  // NBH has no FHR row; its first column is forecast hour 1.
  const forecastHours =
    fhrRow !== null
      ? fhrRow.map((v, i) => {
          if (v === null) throw new NbmParseError(`station ${station} has a null FHR at column ${i}`);
          return v;
        })
      : utcLabels.map((_, i) => i + 1);

  const validTimes = forecastHours.map((fhr) => new Date(cycleTime.getTime() + fhr * 3_600_000));

  // Cross-check derived valid times against the bulletin's printed UTC hours.
  for (let i = 0; i < validTimes.length; i++) {
    const printed = utcLabels[i];
    if (printed === null || printed === undefined) continue;
    const derived = validTimes[i]!.getUTCHours();
    if (derived !== printed) {
      throw new NbmParseError(
        `station ${station} column ${i}: derived valid hour ${derived}Z does not match bulletin's ${printed}Z`,
      );
    }
  }

  return { station: station!, version: version!, product, cycleTime, forecastHours, validTimes, rows, rawHeader: header.trim() };
}

/**
 * Scan a whole bulletin for the requested stations.
 *
 * The operational files are ~28MB covering thousands of stations, so this scans
 * line by line and only materialises the blocks asked for.
 */
export function parseNbmBulletin(text: string, wanted: readonly string[]): Map<string, NbmStationForecast> {
  const want = new Set(wanted);
  const found = new Map<string, NbmStationForecast>();
  const lines = text.split("\n");

  let current: string[] | null = null;
  let currentStation: string | null = null;

  const flush = () => {
    if (current && currentStation && want.has(currentStation)) {
      found.set(currentStation, parseStationBlock(current));
    }
    current = null;
    currentStation = null;
  };

  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      currentStation = m[1] ?? null;
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  flush();

  return found;
}

/** Official NOAA Open Data mirror of the operational NCEP blend text products. */
export const NBM_TEXT_BASE = "https://noaa-nbm-grib2-pds.s3.amazonaws.com";

export function nbmBulletinUrl(product: NbmProduct, cycle: Date): string {
  const yyyymmdd =
    `${cycle.getUTCFullYear()}` +
    `${String(cycle.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(cycle.getUTCDate()).padStart(2, "0")}`;
  const hh = String(cycle.getUTCHours()).padStart(2, "0");
  const file = product === "NBH" ? "blend_nbhtx" : "blend_nbstx";
  return `${NBM_TEXT_BASE}/blend.${yyyymmdd}/${hh}/text/${file}.t${hh}z`;
}

/**
 * The most recent cycle plausibly published by `now`.
 *
 * NBM runs hourly; the text bulletins lag the cycle by roughly an hour, so we
 * step back by `publishLagHours` before selecting. Selecting a cycle that has
 * not published yet is not a lookahead risk (it simply 404s), but it wastes a
 * request and makes staleness reasoning muddier.
 */
export function latestAvailableCycle(now: Date, publishLagHours = 2): Date {
  const t = new Date(now.getTime() - publishLagHours * 3_600_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours()));
}

/** Temperature series with its per-hour standard deviation, both station-basis. */
export function temperatureSeries(f: NbmStationForecast): Array<{
  validTime: Date;
  forecastHour: number;
  temperatureF: number;
  sdF: number | null;
}> {
  const tmp = f.rows["TMP"] ?? [];
  const tsd = f.rows["TSD"] ?? [];
  const out: Array<{ validTime: Date; forecastHour: number; temperatureF: number; sdF: number | null }> = [];
  for (let i = 0; i < f.validTimes.length; i++) {
    const t = tmp[i];
    if (t === null || t === undefined) continue;
    out.push({
      validTime: f.validTimes[i]!,
      forecastHour: f.forecastHours[i]!,
      temperatureF: t,
      sdF: tsd[i] ?? null,
    });
  }
  return out;
}

/**
 * Forecast daily maximum over a local calendar day, from the hourly series.
 *
 * Uses the hourly TMP rather than NBS's TXN because TXN's window is a fixed
 * NBM convention that does not necessarily coincide with the contract's local
 * settlement day, and a mismatched window is exactly the class of error this
 * whole module exists to prevent.
 */
export function forecastDailyMax(
  f: NbmStationForecast,
  localDate: string,
  timeZone: string,
): { maxF: number; sdF: number | null; hoursCovered: number; complete: boolean } | null {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const series = temperatureSeries(f).filter((s) => fmt.format(s.validTime) === localDate);
  if (series.length === 0) return null;

  const peak = series.reduce((a, b) => (b.temperatureF > a.temperatureF ? b : a));
  const hours = new Set(series.map((s) => s.validTime.getUTCHours()));

  return {
    maxF: peak.temperatureF,
    sdF: peak.sdF,
    hoursCovered: hours.size,
    // A daily maximum is only trustworthy if the guidance actually spans the
    // afternoon; a series that stops at noon has not seen the peak.
    complete: series.some((s) => {
      const localHour = Number(
        new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(s.validTime),
      );
      return localHour >= 17;
    }),
  };
}
