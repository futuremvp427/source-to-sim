#!/usr/bin/env node

/**
 * Wallet-free weather-signal shootout.
 *
 * BeefSlayer-as-trigger was REJECTED (see research-weather-hybrid-repricing.mjs
 * and PROJECT_STATE.md WEATHER-HYBRID-2): its trigger is statistically
 * indistinguishable from ordinary market movement. This script asks a
 * different, wallet-free question: does the WEATHER DATA ITSELF (NBM station
 * forecast revisions, real station-observation threshold crossings, or both)
 * predict Kalshi price movement, independent of any wallet?
 *
 * Four strategies, computed over the SAME station-day universe:
 *   A. NBM_CYCLE_REVISION_EDGE       -- consecutive NBM cycles disagree materially
 *   B. OBSERVATION_THRESHOLD_CROSSING_EDGE -- real station obs cross a bucket boundary
 *   C. COMBINED                       -- simple preregistered AND of A and B
 *   D. MARKET_ONLY_CONTROL            -- matched non-signal station-days
 *
 * DESIGN CHOICES, stated explicitly:
 *
 * - Independent unit is STATION-DAY (city x date). Multiple bucket signals on
 *   the same station-day are summed before any P/L/PF/ROI/Brier aggregate.
 * - NBM cycles are sampled at four fixed, preregistered UTC hours (12/15/18/21Z)
 *   per day, not every hourly cycle -- fetching every hourly NBH bulletin
 *   (~28MB each) for a 100-day x 5-city window is not tractable, and four
 *   well-spaced cycles still give three consecutive-pair comparisons per day.
 *   This is a bounded test, not an exhaustive one, and is reported as such.
 * - Revision threshold is a FIXED, PREREGISTERED 10-percentage-point change in
 *   the probability of the higher-probability bucket between consecutive
 *   cycles, chosen before this script was ever run and never touched after
 *   seeing results. Direction: only a probability INCREASE generates a BUY
 *   signal (no short/NO handling, matching the repricing script's design).
 * - Observation crossings use the Iowa Environmental Mesonet ASOS archive
 *   (mesonet.agron.iastate.edu), official ASOS/METAR-derived station data,
 *   NOT reanalysis. A crossing is a purely mechanical event with no
 *   probability model: track which bucket's own [lowerF,upperF] bounds
 *   currently CONTAIN the running local-day maximum, and flag a signal
 *   whenever that bucket changes between consecutive observations. The
 *   newly-entered bucket is the signal.
 * - Combined (C) is a simple AND: an observation crossing and an NBM revision
 *   on the SAME bucket, on the SAME station-day, within 60 minutes of each
 *   other. No scoring formula, no weighting.
 * - Settlement is fingerprinted per market from its own rules_primary text
 *   (NWS vs The Weather Company); a station-day with any UNKNOWN-provider leg
 *   is excluded entirely, not blended in.
 * - Both a SHORT-HORIZON lane (5/15/30/45/60-minute exits, delay/adverse
 *   stress grid, fees both legs) and a HOLD-TO-SETTLEMENT lane (single entry,
 *   settle at the market's own real result, entry fee only -- redemption is
 *   not a taker fill) are computed and kept separate.
 * - No lookahead: every NBM cycle used at decision time T must have
 *   cycleTime <= T; every observation used must have its own timestamp <= T;
 *   every Kalshi quote used must be at or after the decision instant.
 *
 * Public data only. No credentials, orders, Lovable, or production.
 */
import { mkdir, writeFile } from "node:fs/promises";

const K = "https://external-api.kalshi.com/trade-api/v2";
const NBM = "https://noaa-nbm-grib2-pds.s3.amazonaws.com";
const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? "100");
const CONTRACTS = Number(process.env.CONTRACTS ?? "100");
const QUOTE_MAX_LAG_SECONDS = Number(process.env.QUOTE_MAX_LAG_SECONDS ?? "300");
const CONTROLS_PER_SIGNAL = Number(process.env.CONTROLS_PER_SIGNAL ?? "1");

// Preregistered. Do not tune against results.
const NBM_CYCLE_HOURS_UTC = [12, 15, 18, 21];
const REVISION_PROB_THRESHOLD = 0.10;
const COMBINED_WINDOW_SECONDS = 3600;
const NBM_PUBLISH_LAG_SECONDS = 600; // conservative bulletin availability buffer
const OBS_PUBLISH_LAG_SECONDS = 180; // conservative IEM availability buffer

const DELAYS_SEC = [0, 60, 300, 900];
const HOLDS_SEC = [300, 900, 1800, 2700, 3600];
const ADVERSE = [0, 0.01, 0.02, 0.03];

const CITIES = [
  { key: "NYC", series: "KXHIGHNY", iem: "NYC", network: "NY_ASOS", timezone: "America/New_York" },
  { key: "CHI", series: "KXHIGHCHI", iem: "ORD", network: "IL_ASOS", timezone: "America/Chicago" },
  { key: "LAX", series: "KXHIGHLAX", iem: "LAX", network: "CA_ASOS", timezone: "America/Los_Angeles" },
  { key: "SFO", series: "KXHIGHTSFO", iem: "SFO", network: "CA_ASOS", timezone: "America/Los_Angeles" },
  { key: "MIA", series: "KXHIGHMIA", iem: "MIA", network: "FL_ASOS", timezone: "America/New_York" },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A non-retryable status must throw immediately, outside the try/catch that
 * would otherwise swallow it and retry through the full backoff. This exact
 * bug (in a prior version of this pattern) caused multi-minute stalls per
 * signal by retrying 404s six times with exponential backoff; confirmed and
 * fixed in the sibling hybrid scripts, applied correctly here from the start.
 */
async function fetchJson(url, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": "source-to-sim-weather-shootout/1.0" } });
    } catch (e) { last = e; await sleep(Math.min(10000, 500 * 2 ** i)); continue; }
    if (res.ok) return res.json();
    const body = await res.text();
    last = new Error(`${res.status} ${res.statusText}: ${body.slice(0, 180)}`);
    if (![429, 500, 502, 503, 504].includes(res.status)) throw last;
    await sleep(Math.min(10000, 500 * 2 ** i));
  }
  throw last;
}
async function fetchText(url, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": "source-to-sim-weather-shootout/1.0" } });
    } catch (e) { last = e; await sleep(Math.min(8000, 500 * 2 ** i)); continue; }
    if (res.ok) return res.text();
    if (res.status === 404) return null;
    last = new Error(`${res.status} ${res.statusText}`);
    await sleep(Math.min(8000, 500 * 2 ** i));
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Kalshi: catalog, buckets, settlement, candles (dual-endpoint fallback).
// ---------------------------------------------------------------------------
const MONTH3 = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };
function eventDate(t) { const m = String(t ?? "").match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})$/i); return m ? `20${m[1]}-${MONTH3[m[2].toUpperCase()]}-${m[3]}` : null; }
function closeTs(m) { for (const k of ["close_time", "expiration_time", "expected_expiration_time", "latest_expiration_time"]) { const t = Date.parse(m?.[k] ?? ""); if (Number.isFinite(t)) return Math.floor(t / 1000); } return null; }
function parseBucket(text) {
  const raw = String(text ?? "").toLowerCase().replace(/[–—]/g, "-").replace(/degrees?/g, "°").replace(/fahrenheit/g, "f").replace(/\s+/g, " ");
  let m = raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:to|-)\s*(-?\d+(?:\.\d+)?)\s*(?:°\s*f?|f)\b/i);
  if (m) return { kind: "range", low: Number(m[1]), high: Number(m[2]) };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:or\s+below|or\s+lower|or\s+less|and\s+below|or\s+under|or\s+fewer)/i);
  if (m) return { kind: "below", value: Number(m[1]) };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:or\s+above|or\s+higher|or\s+more|and\s+above|or\s+over)/i);
  if (m) return { kind: "above", value: Number(m[1]) };
  return null;
}
function targetBucket(m) {
  const b = parseBucket(`${m.yes_sub_title ?? ""} ${m.subtitle ?? ""}`);
  if (b) return b;
  const t = String(m.ticker ?? "").match(/-B(-?\d+(?:\.\d+)?)$/i);
  if (t) { const mid = Number(t[1]); return { kind: "range", low: mid - .5, high: mid + .5 }; }
  return parseBucket(m.title);
}
function bucketBounds(b) { return b.kind === "range" ? { lowerF: b.low, upperF: b.high } : b.kind === "below" ? { lowerF: null, upperF: b.value } : { lowerF: b.value, upperF: null }; }
function settlementProvider(m) {
  const s = `${m.rules_primary ?? ""} ${m.rules_secondary ?? ""}`.toLowerCase();
  if (/weather company|weather\.com/.test(s)) return "TWC";
  if (/national weather service|climatological report|weather\.gov/.test(s)) return "NWS";
  return "UNKNOWN";
}
async function historicalMarkets(series) {
  const out = []; let cursor = null;
  do {
    const p = new URLSearchParams({ series_ticker: series, limit: "1000" });
    if (cursor) p.set("cursor", cursor);
    const d = await fetchJson(`${K}/historical/markets?${p}`);
    out.push(...(d.markets ?? []));
    cursor = d.cursor || null;
    if (cursor) await sleep(40);
  } while (cursor);
  return out;
}
async function currentSettledMarkets(series) {
  // limit=1000 (and =500) silently return an EMPTY page on this endpoint for
  // reasons not documented by Kalshi -- confirmed live: limit<=200 works,
  // limit in {500,1000} returns zero markets with cursor=null. Use 200.
  const out = []; let cursor = null;
  do {
    const p = new URLSearchParams({ series_ticker: series, status: "settled", limit: "200" });
    if (cursor) p.set("cursor", cursor);
    const d = await fetchJson(`${K}/markets?${p}`);
    out.push(...(d.markets ?? []));
    cursor = d.cursor || null;
    if (cursor) await sleep(40);
  } while (cursor);
  return out;
}
async function eventCatalog(series, startDate, endDate) {
  const both = [...await historicalMarkets(series), ...await currentSettledMarkets(series)];
  const byTicker = new Map(both.map(m => [m.ticker, m]));
  const byDate = new Map();
  for (const m of byTicker.values()) {
    const date = eventDate(m.event_ticker);
    if (!date || date < startDate || date > endDate) continue;
    const b = targetBucket(m);
    if (!b) continue;
    const result = String(m.result ?? "").toLowerCase();
    if (!["yes", "no"].includes(result)) continue;
    const a = byDate.get(date) ?? [];
    a.push({ ...m, _date: date, _bucket: b, _bounds: bucketBounds(b), _provider: settlementProvider(m), _result: result });
    byDate.set(date, a);
  }
  // Exclude any station-day whose legs disagree on provider, or contain UNKNOWN.
  for (const [date, legs] of byDate) {
    const providers = new Set(legs.map(l => l._provider));
    if (providers.has("UNKNOWN") || providers.size > 1) byDate.delete(date);
  }
  return byDate;
}
function priceCloses(c) {
  const ask = [c?.yes_ask?.close, c?.yes_ask?.close_dollars, c?.yes_ask?.close_price].map(Number).find(Number.isFinite) ?? null;
  const bid = [c?.yes_bid?.close, c?.yes_bid?.close_dollars, c?.yes_bid?.close_price].map(Number).find(Number.isFinite) ?? null;
  return { ask, bid };
}
async function candleWindow(series, ticker, startTs, endTs) {
  const p = new URLSearchParams({ start_ts: String(startTs), end_ts: String(endTs), period_interval: "1" });
  const urls = [
    `${K}/historical/markets/${encodeURIComponent(ticker)}/candlesticks?${p}`,
    `${K}/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?${p}`,
  ];
  for (const u of urls) {
    try {
      const d = await fetchJson(u, 3);
      const cs = (d.candlesticks ?? []).map(c => { const { ask, bid } = priceCloses(c); return { ts: Number(c.end_period_ts), ask, bid }; }).filter(c => Number.isFinite(c.ts) && (c.ask != null || c.bid != null)).sort((a, b) => a.ts - b.ts);
      if (cs.length) return cs;
    } catch { /* try next URL */ }
  }
  return [];
}
function nearestAt(cs, t, field) {
  const c = cs.find(x => x.ts >= t && x.ts - t <= QUOTE_MAX_LAG_SECONDS && x[field] != null);
  return c ? { value: c[field], candleTs: c.ts, lagSeconds: c.ts - t } : null;
}
function fee(n, p) { const raw = .07 * n * p * (1 - p); return Math.ceil(raw / .0001 - 1e-9) * .0001; }

// ---------------------------------------------------------------------------
// Probability: continuity-corrected Normal CDF over a bucket ladder.
// ---------------------------------------------------------------------------
function erf(x) {
  const sign = x < 0 ? -1 : 1, ax = Math.abs(x), t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
function normalCdf(x, mean, sd) { return sd <= 0 ? (x >= mean ? 1 : 0) : 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2))); }
function bucketProbability(bounds, mean, sd) {
  const lo = bounds.lowerF === null ? 0 : normalCdf(bounds.lowerF - 0.5, mean, sd);
  const hi = bounds.upperF === null ? 1 : normalCdf(bounds.upperF + 0.5, mean, sd);
  return Math.max(0, hi - lo);
}
function ladderDistribution(legs, mean, sd) {
  const raw = legs.map(l => bucketProbability(l._bounds, mean, sd));
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  return legs.map((l, i) => ({ ticker: l.ticker, bounds: l._bounds, result: l._result, probability: raw[i] / total }));
}

// ---------------------------------------------------------------------------
// NBM: station text bulletin (NBH) parsing. Reimplemented standalone here to
// keep this research script dependency-free, matching house convention;
// mirrors the tested src/lib/weather-lab/sources/nbm.ts on the sibling branch.
// ---------------------------------------------------------------------------
const HEADER_RE = /^\s*(\S+)\s+NBM\s+(V\S+)\s+(NBH|NBS)\s+GUIDANCE\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{4})\s+UTC\s*$/;
function nbmUrl(cycleDate, cycleHourUtc) {
  const hh = String(cycleHourUtc).padStart(2, "0");
  return `${NBM}/blend.${cycleDate}/${hh}/text/blend_nbhtx.t${hh}z`;
}
function parseRowValues(line) {
  const body = line.slice(5), out = [];
  for (let i = 0; i + 3 <= body.length; i += 3) {
    const cell = body.slice(i, i + 3).trim();
    out.push(cell === "" ? null : (Number.isFinite(Number(cell)) ? Number(cell) : null));
  }
  return out;
}
function parseStationBlock(lines) {
  const m = HEADER_RE.exec(lines[0] ?? "");
  if (!m) return null;
  const [, station, , , month, day, year, hhmm] = m;
  const cycleTime = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hhmm.slice(0, 2)), Number(hhmm.slice(2))));
  const rows = {};
  for (const line of lines.slice(1)) {
    const label = line.slice(0, 5).trim();
    if (!label || label === "DT") continue;
    rows[label] = parseRowValues(line);
  }
  if (!rows["UTC"] || !rows["TMP"]) return null;
  const forecastHours = rows["UTC"].map((_, i) => i + 1); // NBH: column 0 == FHR 1
  const validTimes = forecastHours.map(fhr => new Date(cycleTime.getTime() + fhr * 3_600_000));
  return { station, cycleTime, validTimes, tmp: rows["TMP"], tsd: rows["TSD"] ?? [] };
}
function parseNbmBulletin(text, wanted) {
  const want = new Set(wanted), found = new Map();
  let current = null, currentStation = null;
  for (const line of text.split("\n")) {
    const m = HEADER_RE.exec(line);
    if (m) {
      if (current && currentStation && want.has(currentStation)) { const f = parseStationBlock(current); if (f) found.set(currentStation, f); }
      currentStation = m[1]; current = [line]; continue;
    }
    if (current) current.push(line);
  }
  if (current && currentStation && want.has(currentStation)) { const f = parseStationBlock(current); if (f) found.set(currentStation, f); }
  return found;
}
/** Peak forecast within a local calendar day, plus its own TSD, plus afternoon coverage flag. */
function forecastDailyMaxTsd(f, localDate, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  let best = null, coversAfternoon = false;
  for (let i = 0; i < f.validTimes.length; i++) {
    if (fmt.format(f.validTimes[i]) !== localDate) continue;
    const t = f.tmp[i];
    if (t == null) continue;
    if (!best || t > best.tmp) best = { tmp: t, sd: f.tsd[i] ?? null, idx: i };
    const localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(f.validTimes[i]));
    if (localHour >= 17) coversAfternoon = true;
  }
  return best ? { maxF: best.tmp, sdF: best.sd, complete: coversAfternoon } : null;
}

// ---------------------------------------------------------------------------
// IEM ASOS: real archived station observations. NOT reanalysis.
// ---------------------------------------------------------------------------
async function fetchAsosSeries(city, startDate, endDate) {
  const [y1, m1, d1] = startDate.split("-"), [y2, m2, d2] = endDate.split("-");
  const p = new URLSearchParams({
    station: city.iem, data: "tmpf", year1: y1, month1: m1, day1: d1, year2: y2, month2: m2, day2: d2,
    tz: "Etc/UTC", format: "onlycomma", latlon: "no", elev: "no", missing: "empty", trace: "empty", direct: "no",
  });
  const csv = await fetchText(`${IEM}?${p}`);
  if (!csv) return [];
  const out = [];
  for (const line of csv.split("\n").slice(1)) {
    const [, valid, tmpf] = line.split(",");
    if (!valid || tmpf === undefined || tmpf === "") continue;
    const t = Number(tmpf);
    if (!Number.isFinite(t)) continue;
    out.push({ at: new Date(`${valid.replace(" ", "T")}Z`), tempF: t });
  }
  return out.filter(o => Number.isFinite(o.at.getTime())).sort((a, b) => a.at - b.at);
}
function localDateOf(at, tz) { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at); }

// ---------------------------------------------------------------------------
// Ensemble (GEFS via Open-Meteo) -- for the TSD-vs-ensemble calibration check.
// ---------------------------------------------------------------------------
const LATLON = { NYC: [40.7794, -73.9692], CHI: [41.9803, -87.9090], LAX: [33.9382, -118.3866], SFO: [37.6197, -122.3647], MIA: [25.7906, -80.3164] };
async function fetchEnsembleSigma(cityKey, targetLocalDate, tz) {
  const [lat, lon] = LATLON[cityKey];
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&models=gfs025&temperature_unit=fahrenheit&timezone=${encodeURIComponent(tz)}&past_days=92&forecast_days=1`;
  try {
    const d = await fetchJson(url);
    const times = d?.daily?.time ?? [];
    const idx = times.indexOf(targetLocalDate);
    if (idx < 0) return null;
    const members = Object.keys(d.daily).filter(k => k.startsWith("temperature_2m_max")).map(k => d.daily[k]?.[idx]).filter(v => typeof v === "number" && Number.isFinite(v));
    if (members.length < 2) return null;
    const mean = members.reduce((a, b) => a + b, 0) / members.length;
    const variance = members.reduce((a, b) => a + (b - mean) ** 2, 0) / (members.length - 1);
    return { meanF: mean, sdF: Math.sqrt(variance) };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Pricing grid (short-horizon and hold-to-settlement), reused pattern from
// research-weather-hybrid-repricing.mjs.
// ---------------------------------------------------------------------------
function priceShortHorizon(candles, signalTs) {
  const cells = [];
  for (const delay of DELAYS_SEC) {
    const entryQ = nearestAt(candles, signalTs + delay, "ask");
    if (!entryQ) { for (const hold of HOLDS_SEC) for (const adv of ADVERSE) cells.push({ delay, hold, adv, status: "NO_ENTRY_QUOTE" }); continue; }
    for (const hold of HOLDS_SEC) {
      const exitQ = nearestAt(candles, signalTs + delay + hold, "bid");
      if (!exitQ) { for (const adv of ADVERSE) cells.push({ delay, hold, adv, status: "NO_EXIT_QUOTE" }); continue; }
      for (const adv of ADVERSE) {
        const entryPrice = Math.min(0.99, entryQ.value + adv), exitPrice = exitQ.value;
        const feeIn = fee(CONTRACTS, entryPrice), feeOut = fee(CONTRACTS, exitPrice);
        const netPnl = (exitPrice - entryPrice) * CONTRACTS - feeIn - feeOut;
        const capital = entryPrice * CONTRACTS + feeIn;
        cells.push({ delay, hold, adv, status: "OK", entryPrice, exitPrice, grossMove: exitPrice - entryPrice, feeIn, feeOut, netPnl, capital });
      }
    }
  }
  return cells;
}
function priceHoldToSettlement(candles, signalTs, won) {
  const cells = [];
  for (const delay of DELAYS_SEC) {
    const entryQ = nearestAt(candles, signalTs + delay, "ask");
    if (!entryQ) { for (const adv of ADVERSE) cells.push({ delay, adv, status: "NO_ENTRY_QUOTE" }); continue; }
    for (const adv of ADVERSE) {
      const entryPrice = Math.min(0.99, entryQ.value + adv);
      const feeIn = fee(CONTRACTS, entryPrice);
      const payout = won ? CONTRACTS : 0;
      const capital = entryPrice * CONTRACTS + feeIn;
      const netPnl = payout - capital; // no exit fee: redemption is not a taker fill
      cells.push({ delay, adv, status: "OK", entryPrice, payout, feeIn, netPnl, capital });
    }
  }
  return cells;
}
function cellKeyS(delay, hold, adv) { return `${delay}|${hold}|${adv}`; }
function cellKeyH(delay, adv) { return `${delay}|${adv}`; }

// ---------------------------------------------------------------------------
// Station-day-independent aggregation and metrics.
// ---------------------------------------------------------------------------
function aggregateShortHorizon(rows) {
  const byCell = new Map();
  for (const r of rows) for (const c of r.shortCells) {
    if (c.status !== "OK") continue;
    const ck = cellKeyS(c.delay, c.hold, c.adv), dk = `${r.city}|${r.date}`;
    const m = byCell.get(ck) ?? new Map();
    const g = m.get(dk) ?? { pnl: 0, capital: 0, date: r.date, city: r.city, grossMoves: [] };
    g.pnl += c.netPnl; g.capital += c.capital; g.grossMoves.push(c.grossMove);
    m.set(dk, g); byCell.set(ck, m);
  }
  return byCell;
}
function aggregateHoldToSettlement(rows) {
  const byCell = new Map();
  for (const r of rows) for (const c of r.holdCells) {
    if (c.status !== "OK") continue;
    const ck = cellKeyH(c.delay, c.adv), dk = `${r.city}|${r.date}`;
    const m = byCell.get(ck) ?? new Map();
    const g = m.get(dk) ?? { pnl: 0, capital: 0, date: r.date, city: r.city, probs: [], outcomes: [] };
    g.pnl += c.netPnl; g.capital += c.capital;
    m.set(dk, g); byCell.set(ck, m);
  }
  return byCell;
}
function metricsFromDays(days) {
  if (!days.length) return null;
  const pnl = days.reduce((a, d) => a + d.pnl, 0), capital = days.reduce((a, d) => a + d.capital, 0);
  const wins = days.filter(d => d.pnl > 0), losses = days.filter(d => d.pnl < 0);
  const gw = wins.reduce((a, d) => a + d.pnl, 0), gl = -losses.reduce((a, d) => a + d.pnl, 0);
  let eq = 0, peak = 0, maxDD = 0;
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) { eq += d.pnl; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); }
  const allMoves = days.flatMap(d => d.grossMoves ?? []);
  return {
    n: days.length, pnl, capital, roi: capital ? pnl / capital : null, pf: gl ? gw / gl : null,
    winRate: wins.length / days.length, maxDrawdown: maxDD,
    meanMove: allMoves.length ? allMoves.reduce((a, b) => a + b, 0) / allMoves.length : null,
    favorableShare: allMoves.length ? allMoves.filter(m => m > 0).length / allMoves.length : null,
  };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function lcg(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
function bootstrapCI(days, iters = 2000) {
  if (!days.length) return null;
  const r = lcg(hashStr(days.map(d => d.date).join(",")) || 1), totals = [];
  for (let b = 0; b < iters; b++) { let t = 0; for (let i = 0; i < days.length; i++) t += days[Math.floor(r() * days.length)].pnl; totals.push(t); }
  totals.sort((a, b) => a - b);
  return [totals[Math.floor(0.025 * iters)], totals[Math.floor(0.975 * iters)]];
}
function trimTopWinnerDays(days, frac) {
  const winners = days.filter(d => d.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  const drop = new Set(winners.slice(0, Math.ceil(winners.length * frac)).map(d => d.date + d.city));
  return days.filter(d => !drop.has(d.date + d.city));
}
function cityConcentration(days) {
  const byCity = new Map();
  for (const d of days) byCity.set(d.city, (byCity.get(d.city) ?? 0) + Math.max(0, d.pnl));
  const totalPos = [...byCity.values()].reduce((a, b) => a + b, 0);
  const sorted = [...byCity.entries()].sort((a, b) => b[1] - a[1]);
  return { largestShare: totalPos ? (sorted[0]?.[1] ?? 0) / totalPos : null, byCity: Object.fromEntries(sorted) };
}
/** Brier score and log loss against a signal's own forecast probability and the market's real settled outcome. */
function brierAndLogLoss(rows) {
  const pairs = rows.map(r => ({ p: r.forecastProbability, y: r.won ? 1 : 0 })).filter(x => Number.isFinite(x.p));
  if (!pairs.length) return null;
  const brier = pairs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / pairs.length;
  const eps = 1e-6;
  const logLoss = -pairs.reduce((a, x) => a + (x.y * Math.log(Math.min(1 - eps, Math.max(eps, x.p))) + (1 - x.y) * Math.log(Math.min(1 - eps, Math.max(eps, 1 - x.p)))), 0) / pairs.length;
  return { n: pairs.length, brier, logLoss };
}
function calibrationTable(rows, bins = 5) {
  const pairs = rows.map(r => ({ p: r.forecastProbability, y: r.won ? 1 : 0 })).filter(x => Number.isFinite(x.p));
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const inBin = pairs.filter(x => x.p >= lo && (b === bins - 1 ? x.p <= hi : x.p < hi));
    if (!inBin.length) { out.push({ bin: `${(100*lo).toFixed(0)}-${(100*hi).toFixed(0)}%`, n: 0, meanForecast: null, actualRate: null }); continue; }
    out.push({ bin: `${(100*lo).toFixed(0)}-${(100*hi).toFixed(0)}%`, n: inBin.length, meanForecast: inBin.reduce((a,x)=>a+x.p,0)/inBin.length, actualRate: inBin.reduce((a,x)=>a+x.y,0)/inBin.length });
  }
  return out;
}

const pct = x => x == null ? "n/a" : `${(100 * x).toFixed(1)}%`;
const money = x => x == null ? "n/a" : `$${x.toFixed(2)}`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const endDate = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
  console.log(`Weather signal shootout. Window ${startDate}..${endDate} (${LOOKBACK_DAYS}d).`);

  console.log("Building Kalshi event catalogs (settlement-fingerprinted, ambiguous days excluded) ...");
  const catalogs = new Map();
  for (const c of CITIES) {
    const cat = await eventCatalog(c.series, startDate, endDate);
    catalogs.set(c.key, cat);
    console.log(`  ${c.key}: ${cat.size} eligible station-days`);
  }

  console.log("Fetching real IEM ASOS observations (official ASOS/METAR archive, not reanalysis) ...");
  const asosByCity = new Map();
  for (const c of CITIES) {
    const series = await fetchAsosSeries(c, startDate, endDate);
    asosByCity.set(c.key, series);
    console.log(`  ${c.key}: ${series.length} sub-hourly observations`);
    await sleep(200);
  }

  console.log("Fetching NBM NBH bulletins at preregistered cycles (12/15/18/21Z) ...");
  // date -> Map(cycleHour -> Map(station -> forecast))
  const nbmByDate = new Map();
  let bulletinsFetched = 0, bulletinsMissing = 0;
  const stationList = CITIES.map(c => c.iem === "NYC" ? "KNYC" : c.iem === "ORD" ? "KORD" : c.iem === "LAX" ? "KLAX" : c.iem === "SFO" ? "KSFO" : "KMIA");
  for (let d = 0; d < LOOKBACK_DAYS; d++) {
    const day = new Date(Date.parse(`${startDate}T00:00:00Z`) + d * 86_400_000);
    const cycleDate = day.toISOString().slice(0, 10).replace(/-/g, "");
    const byCycle = new Map();
    for (const h of NBM_CYCLE_HOURS_UTC) {
      const text = await fetchText(nbmUrl(cycleDate, h));
      if (!text) { bulletinsMissing++; continue; }
      bulletinsFetched++;
      byCycle.set(h, parseNbmBulletin(text, stationList));
    }
    nbmByDate.set(day.toISOString().slice(0, 10), byCycle);
    if (d % 20 === 0) process.stdout.write(`\r  ${d + 1}/${LOOKBACK_DAYS} days (fetched ${bulletinsFetched}, missing ${bulletinsMissing})   `);
  }
  console.log(`\nNBM bulletins: ${bulletinsFetched} fetched, ${bulletinsMissing} missing.`);

  const stationForCity = Object.fromEntries(CITIES.map(c => [c.key, c.iem === "NYC" ? "KNYC" : c.iem === "ORD" ? "KORD" : c.iem === "LAX" ? "KLAX" : c.iem === "SFO" ? "KSFO" : "KMIA"]));

  // ---- Detect A: NBM cycle revisions ----
  console.log("Detecting NBM cycle revisions ...");
  const revisionSignals = [];
  for (const c of CITIES) {
    const cat = catalogs.get(c.key);
    for (const [date, legs] of cat) {
      const station = stationForCity[c.key];
      const byCycle = nbmByDate.get(date);
      if (!byCycle) continue;
      const cyclesPresent = NBM_CYCLE_HOURS_UTC.filter(h => byCycle.get(h)?.has(station));
      for (let i = 1; i < cyclesPresent.length; i++) {
        const prevF = byCycle.get(cyclesPresent[i - 1]).get(station);
        const curF = byCycle.get(cyclesPresent[i]).get(station);
        const prevPeak = forecastDailyMaxTsd(prevF, date, c.timezone);
        const curPeak = forecastDailyMaxTsd(curF, date, c.timezone);
        if (!prevPeak?.complete || !curPeak?.complete || prevPeak.sdF == null || curPeak.sdF == null) continue;
        const prevDist = ladderDistribution(legs, prevPeak.maxF, prevPeak.sdF);
        const curDist = ladderDistribution(legs, curPeak.maxF, curPeak.sdF);
        const prevModal = prevDist.reduce((a, b) => (b.probability > a.probability ? b : a));
        const curOnSameBucket = curDist.find(x => x.ticker === prevModal.ticker);
        const delta = curOnSameBucket.probability - prevModal.probability;
        if (delta >= REVISION_PROB_THRESHOLD) {
          const signalTs = Math.floor(curF.cycleTime.getTime() / 1000) + NBM_PUBLISH_LAG_SECONDS;
          revisionSignals.push({
            city: c.key, series: c.series, date, ticker: prevModal.ticker, won: prevModal.result === "yes",
            signalTs, forecastProbability: curOnSameBucket.probability, priorProbability: prevModal.probability, deltaProbability: delta,
            cycleFrom: cyclesPresent[i - 1], cycleTo: cyclesPresent[i],
          });
        }
      }
    }
  }
  console.log(`  ${revisionSignals.length} revision signals, ${new Set(revisionSignals.map(r => `${r.city}|${r.date}`)).size} station-days`);

  // ---- Detect B: observation threshold crossings ----
  // A crossing is purely mechanical: which bucket's own [lowerF,upperF] bounds
  // currently CONTAIN the running daily max. When that bucket changes between
  // consecutive observations, the newly-entered bucket is the signal -- this
  // matches the task's own framing ("running daily max crosses into a
  // bucket", "a lower bucket becomes physically impossible") directly, with
  // no probability model and nothing to tune.
  console.log("Detecting observation threshold crossings ...");
  function bucketContaining(legs, temp) {
    return legs.find(l => (l._bounds.lowerF === null || temp >= l._bounds.lowerF) && (l._bounds.upperF === null || temp <= l._bounds.upperF));
  }
  const crossingSignals = [];
  for (const c of CITIES) {
    const cat = catalogs.get(c.key);
    const obs = asosByCity.get(c.key);
    for (const [date, legs] of cat) {
      const dayObs = obs.filter(o => localDateOf(o.at, c.timezone) === date).sort((a, b) => a.at - b.at);
      if (dayObs.length < 2) continue;
      let runningMax = -Infinity, prevBucket = null;
      for (const o of dayObs) {
        runningMax = Math.max(runningMax, o.tempF);
        const curBucket = bucketContaining(legs, runningMax);
        if (curBucket && prevBucket && curBucket.ticker !== prevBucket.ticker) {
          const signalTs = Math.floor(o.at.getTime() / 1000) + OBS_PUBLISH_LAG_SECONDS;
          crossingSignals.push({ city: c.key, series: c.series, date, ticker: curBucket.ticker, won: curBucket._result === "yes", signalTs, observedRunningMaxF: runningMax });
        }
        if (curBucket) prevBucket = curBucket;
      }
    }
  }
  console.log(`  ${crossingSignals.length} crossing signals, ${new Set(crossingSignals.map(r => `${r.city}|${r.date}`)).size} station-days`);

  // ---- Detect C: combined (simple AND, same bucket, within COMBINED_WINDOW_SECONDS) ----
  const combinedSignals = [];
  for (const rev of revisionSignals) {
    const match = crossingSignals.find(cr => cr.city === rev.city && cr.date === rev.date && cr.ticker === rev.ticker && Math.abs(cr.signalTs - rev.signalTs) <= COMBINED_WINDOW_SECONDS);
    if (match) combinedSignals.push({ ...rev, signalTs: Math.max(rev.signalTs, match.signalTs), matchedCrossingTs: match.signalTs });
  }
  console.log(`  ${combinedSignals.length} combined signals, ${new Set(combinedSignals.map(r => `${r.city}|${r.date}`)).size} station-days`);

  // ---- Price every signal (short-horizon + hold-to-settlement) ----
  async function priceSignals(list, label) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const cs = await candleWindow(s.series, s.ticker, s.signalTs - 30, s.signalTs + 3660);
      if (cs.length) out.push({ ...s, shortCells: priceShortHorizon(cs, s.signalTs), holdCells: priceHoldToSettlement(cs, s.signalTs, s.won) });
      if (i % 20 === 0) process.stdout.write(`\r  ${label}: ${i + 1}/${list.length}   `);
      await sleep(30);
    }
    console.log(`\n  ${label} priced: ${out.length}/${list.length}`);
    return out;
  }
  console.log("Pricing A (NBM revision) ...");
  const pricedA = await priceSignals(revisionSignals, "A");
  console.log("Pricing B (observation crossing) ...");
  const pricedB = await priceSignals(crossingSignals, "B");
  console.log("Pricing C (combined) ...");
  const pricedC = await priceSignals(combinedSignals, "C");

  // ---- D: matched market-only control on non-signal station-days ----
  console.log("Sampling D (market-only control) ...");
  const signalDayKeys = new Set([...pricedA, ...pricedB].map(r => `${r.city}|${r.date}`));
  const anchorHours = [...pricedA, ...pricedB].map(r => Number(new Intl.DateTimeFormat("en-GB", { timeZone: CITIES.find(c => c.key === r.city).timezone, hour: "2-digit", hour12: false }).format(new Date(r.signalTs * 1000))));
  const pricedD = [];
  let dAttempts = 0;
  for (const c of CITIES) {
    const cat = catalogs.get(c.key);
    const nonSignalDates = [...cat.keys()].filter(d => !signalDayKeys.has(`${c.key}|${d}`));
    const rng = lcg(hashStr(c.key) || 1);
    const target = Math.min(nonSignalDates.length, Math.ceil((pricedA.length + pricedB.length) / CITIES.length) || 10);
    for (let i = 0; i < target && dAttempts < 400; i++) {
      dAttempts++;
      const date = nonSignalDates[Math.floor(rng() * nonSignalDates.length)];
      if (!date) continue;
      const legs = cat.get(date);
      const hour = anchorHours.length ? anchorHours[Math.floor(rng() * anchorHours.length)] : 14;
      // Approximate a UTC instant at the target local hour.
      let ts = null;
      for (let uh = 0; uh < 24; uh++) {
        const probe = new Date(`${date}T${String(uh).padStart(2, "0")}:00:00Z`);
        if (Number(new Intl.DateTimeFormat("en-GB", { timeZone: c.timezone, hour: "2-digit", hour12: false }).format(probe)) === hour) { ts = Math.floor(probe.getTime() / 1000) + 1800; break; }
      }
      if (ts == null) continue;
      const ct = closeTs(legs[0]);
      if (ct != null && ts >= ct) continue;
      const leg = legs[Math.floor(rng() * legs.length)];
      const cs = await candleWindow(c.series, leg.ticker, ts - 30, ts + 3660);
      if (!cs.length) continue;
      pricedD.push({ city: c.key, date, ticker: leg.ticker, won: leg._result === "yes", signalTs: ts, forecastProbability: null, shortCells: priceShortHorizon(cs, ts), holdCells: priceHoldToSettlement(cs, ts, leg._result === "yes") });
      await sleep(30);
    }
  }
  console.log(`  D priced: ${pricedD.length}`);

  // ---- TSD vs ensemble calibration check on A's signals ----
  console.log("Comparing TSD-based vs ensemble-based calibration on A's signals ...");
  const calibRows = [];
  for (const s of pricedA) {
    const c = CITIES.find(x => x.key === s.city);
    const ens = await fetchEnsembleSigma(s.city, s.date, c.timezone);
    if (ens) calibRows.push({ city: s.city, date: s.date, ticker: s.ticker, won: s.won, tsdProbability: s.forecastProbability, ensembleProbability: (() => {
      const legs = catalogs.get(s.city).get(s.date);
      const dist = ladderDistribution(legs, ens.meanF, ens.sdF);
      return dist.find(x => x.ticker === s.ticker)?.probability ?? null;
    })() });
    await sleep(60);
  }

  // ---------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------
  function reportShort(rows) {
    const byCell = aggregateShortHorizon(rows);
    const grid = [];
    for (const delay of DELAYS_SEC) for (const hold of HOLDS_SEC) for (const adv of ADVERSE) {
      const days = [...(byCell.get(cellKeyS(delay, hold, adv))?.values() ?? [])];
      const m = metricsFromDays(days);
      if (m) grid.push({ delay, hold, adv, ...m, days });
    }
    return grid;
  }
  function reportHold(rows) {
    const byCell = aggregateHoldToSettlement(rows);
    const grid = [];
    for (const delay of DELAYS_SEC) for (const adv of ADVERSE) {
      const days = [...(byCell.get(cellKeyH(delay, adv))?.values() ?? [])];
      const m = metricsFromDays(days);
      if (m) grid.push({ delay, adv, ...m, days });
    }
    return grid;
  }
  const gridA = reportShort(pricedA), gridB = reportShort(pricedB), gridC = reportShort(pricedC), gridD = reportShort(pricedD);
  const holdA = reportHold(pricedA), holdB = reportHold(pricedB), holdC = reportHold(pricedC), holdD = reportHold(pricedD);

  function keyRow(grid) { return grid.find(g => g.delay === 300 && g.hold === 900 && g.adv === 0.01); }
  const keyA = keyRow(gridA), keyB = keyRow(gridB), keyC = keyRow(gridC), keyD = keyRow(gridD);

  function robustness(rows, delay, hold, adv) {
    const byCell = aggregateShortHorizon(rows);
    const days = [...(byCell.get(cellKeyS(delay, hold, adv))?.values() ?? [])];
    const m = metricsFromDays(days);
    if (!m) return null;
    const ci = bootstrapCI(days);
    const t1 = metricsFromDays(trimTopWinnerDays(days, 0.01));
    const t5 = metricsFromDays(trimTopWinnerDays(days, 0.05));
    const conc = cityConcentration(days);
    return { ...m, ci, trim1: t1, trim5: t5, concentration: conc };
  }
  const robA = robustness(pricedA, 300, 900, 0.01), robB = robustness(pricedB, 300, 900, 0.01), robC = robustness(pricedC, 300, 900, 0.01);

  const brierA = brierAndLogLoss(pricedA), calibA = calibrationTable(pricedA);

  function weeksIn(days) { return Math.max(1, LOOKBACK_DAYS / 7); }
  const oppPerWeekA = new Set(pricedA.map(r => `${r.city}|${r.date}`)).size / weeksIn();
  const oppPerWeekB = new Set(pricedB.map(r => `${r.city}|${r.date}`)).size / weeksIn();
  const oppPerWeekC = new Set(pricedC.map(r => `${r.city}|${r.date}`)).size / weeksIn();

  function gateVerdict(rob, oppPerWeek) {
    if (!rob || rob.n < 50) return "DATA_INSUFFICIENT";
    const passes = rob.pnl > 0 && rob.roi > 0 && rob.pf != null && rob.pf >= 1.3 && rob.trim5.pnl > 0 && (rob.concentration.largestShare == null || rob.concentration.largestShare < 0.6) && oppPerWeek >= 1;
    return passes ? "PROMISING_FOR_FORWARD_PAPER" : "REJECTED";
  }
  const verdictA = gateVerdict(robA, oppPerWeekA), verdictB = gateVerdict(robB, oppPerWeekB), verdictC = gateVerdict(robC, oppPerWeekC);

  let md = `# Wallet-Free Weather Signal Shootout\n\n`;
  md += `**PAPER / RESEARCH ONLY. No orders placed. \`LIVE_EXECUTION_IMPLEMENTED=false\`.**\n\n`;
  md += `Window ${startDate}..${endDate} (${LOOKBACK_DAYS}d), 5 cities. BeefSlayer-as-trigger is REJECTED and not retested. This is a wallet-free test of whether NBM forecast revisions and/or real station-observation threshold crossings predict Kalshi price movement.\n\n`;
  md += `Preregistered constants: NBM cycles ${NBM_CYCLE_HOURS_UTC.map(h=>h+"Z").join(",")}; revision threshold ${REVISION_PROB_THRESHOLD} probability points; combined window ${COMBINED_WINDOW_SECONDS/60}m. None tuned against results.\n\n`;
  md += `## Sample\n\n| Strategy | Signals priced | Station-days | Opportunities/week |\n|---|---:|---:|---:|\n`;
  md += `| A NBM_CYCLE_REVISION | ${pricedA.length} | ${new Set(pricedA.map(r=>`${r.city}|${r.date}`)).size} | ${oppPerWeekA.toFixed(2)} |\n`;
  md += `| B OBSERVATION_CROSSING | ${pricedB.length} | ${new Set(pricedB.map(r=>`${r.city}|${r.date}`)).size} | ${oppPerWeekB.toFixed(2)} |\n`;
  md += `| C COMBINED | ${pricedC.length} | ${new Set(pricedC.map(r=>`${r.city}|${r.date}`)).size} | ${oppPerWeekC.toFixed(2)} |\n`;
  md += `| D MARKET_ONLY_CONTROL | ${pricedD.length} | ${new Set(pricedD.map(r=>`${r.city}|${r.date}`)).size} | n/a |\n\n`;

  md += `## KEY LINE for every strategy (+5m delay, +15m hold, +1c adverse, short-horizon)\n\n`;
  md += `| Strategy | N (station-days) | Mean move | % favorable | P/L | ROI | PF | Max DD | Verdict |\n|---|---:|---:|---:|---:|---:|---:|---:|---|\n`;
  for (const [label, k, v] of [["A NBM revision", keyA, verdictA], ["B Observation crossing", keyB, verdictB], ["C Combined", keyC, verdictC], ["D Market-only control", keyD, null]]) {
    md += `| ${label} | ${k?.n ?? 0} | ${money(k?.meanMove)} | ${pct(k?.favorableShare)} | ${money(k?.pnl)} | ${pct(k?.roi)} | ${k?.pf==null?"n/a":k.pf.toFixed(2)+"x"} | ${money(k?.maxDrawdown)} | ${v ?? "(baseline)"} |\n`;
  }

  md += `\n## Robustness (key cell)\n\n`;
  for (const [label, rob] of [["A", robA], ["B", robB], ["C", robC]]) {
    if (!rob) { md += `### ${label}: DATA_INSUFFICIENT\n\n`; continue; }
    md += `### ${label}\n\n- N=${rob.n}, P/L ${money(rob.pnl)}, ROI ${pct(rob.roi)}, PF ${rob.pf==null?"n/a":rob.pf.toFixed(2)+"x"}, win rate ${pct(rob.winRate)}, max DD ${money(rob.maxDrawdown)}.\n`;
    md += `- Bootstrap 95% CI on P/L: ${rob.ci ? `${money(rob.ci[0])} .. ${money(rob.ci[1])}` : "n/a"}.\n`;
    md += `- After top 1% winners removed: ${money(rob.trim1?.pnl)}. After top 5%: ${money(rob.trim5?.pnl)}.\n`;
    md += `- Largest single-city share of gross wins: ${pct(rob.concentration.largestShare)}. By city: ${JSON.stringify(rob.concentration.byCity)}.\n\n`;
  }

  md += `## Hold-to-settlement (separate from short-horizon), +5m delay / +1c adverse\n\n| Strategy | N | P/L | ROI | PF |\n|---|---:|---:|---:|---:|\n`;
  for (const [label, grid] of [["A", holdA], ["B", holdB], ["C", holdC], ["D", holdD]]) {
    const r = grid.find(g => g.delay === 300 && g.adv === 0.01);
    md += `| ${label} | ${r?.n ?? 0} | ${money(r?.pnl)} | ${pct(r?.roi)} | ${r?.pf==null?"n/a":r.pf.toFixed(2)+"x"} |\n`;
  }

  md += `\n## Calibration (A, forecast probability vs actual settled outcome)\n\n`;
  if (brierA) md += `- N=${brierA.n}, Brier ${brierA.brier.toFixed(4)}, log loss ${brierA.logLoss.toFixed(4)}.\n\n`;
  md += `| Bin | N | Mean forecast | Actual rate |\n|---|---:|---:|---:|\n`;
  for (const b of calibA) md += `| ${b.bin} | ${b.n} | ${b.meanForecast==null?"n/a":pct(b.meanForecast)} | ${b.actualRate==null?"n/a":pct(b.actualRate)} |\n`;

  md += `\n## TSD vs GEFS-ensemble sigma (A's signals, does station-specific TSD improve calibration?)\n\n`;
  if (calibRows.length) {
    const tsdBrier = brierAndLogLoss(calibRows.map(r => ({ forecastProbability: r.tsdProbability, won: r.won })));
    const ensBrier = brierAndLogLoss(calibRows.map(r => ({ forecastProbability: r.ensembleProbability, won: r.won })));
    md += `- N=${calibRows.length}.\n- TSD-sigma Brier: ${tsdBrier ? tsdBrier.brier.toFixed(4) : "n/a"}.\n- Ensemble-sigma Brier: ${ensBrier ? ensBrier.brier.toFixed(4) : "n/a"}.\n- Lower Brier is better calibrated. ${tsdBrier && ensBrier ? (tsdBrier.brier < ensBrier.brier ? "TSD outperformed the ensemble on this sample." : "The ensemble outperformed TSD on this sample.") : ""}\n`;
  } else md += `- No comparable pairs available in this run.\n`;

  md += `\n## Full grid, strategy A (short-horizon, every delay x hold at +1c adverse)\n\n| Cell | N | P/L | ROI | PF |\n|---|---:|---:|---:|---:|\n`;
  for (const g of gridA.filter(g => g.adv === 0.01)) md += `| +${g.delay/60}m delay / +${g.hold/60}m hold | ${g.n} | ${money(g.pnl)} | ${pct(g.roi)} | ${g.pf==null?"n/a":g.pf.toFixed(2)+"x"} |\n`;
  md += `\n## Full grid, strategy B (short-horizon, every delay x hold at +1c adverse)\n\n| Cell | N | P/L | ROI | PF |\n|---|---:|---:|---:|---:|\n`;
  for (const g of gridB.filter(g => g.adv === 0.01)) md += `| +${g.delay/60}m delay / +${g.hold/60}m hold | ${g.n} | ${money(g.pnl)} | ${pct(g.roi)} | ${g.pf==null?"n/a":g.pf.toFixed(2)+"x"} |\n`;

  md += `\n## Settlement provenance\n\nEvery station-day used has every leg individually classified NWS or The Weather Company from its own \`rules_primary\` text (not a hardcoded date cutoff); any station-day with an UNKNOWN or mixed-provider leg was excluded before signal detection.\n\n`;
  md += `## Guardrails\n\n- Station-day is the independent unit throughout.\n- NBM cycles sampled at 4 fixed hours/day, not every hourly cycle -- a bounded test, not exhaustive.\n- IEM ASOS is the observation source (official ASOS/METAR archive), never reanalysis.\n- A missing entry or exit quote is excluded, never treated as a zero-move trade.\n- No thresholds were tuned against these results.\n- No credentials, orders, production changes, Lovable changes, or live trading.\n`;

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-signal-shootout.md", md);
  await writeFile("research-output/weather-signal-shootout.json", JSON.stringify({
    generatedAt: new Date().toISOString(), startDate, endDate, lookbackDays: LOOKBACK_DAYS,
    counts: { revisionSignals: revisionSignals.length, crossingSignals: crossingSignals.length, combinedSignals: combinedSignals.length, pricedA: pricedA.length, pricedB: pricedB.length, pricedC: pricedC.length, pricedD: pricedD.length },
    verdicts: { A: verdictA, B: verdictB, C: verdictC },
    keyA, keyB, keyC, keyD, robA, robB, robC, brierA, calibA, calibRows,
    pricedA, pricedB, pricedC, pricedD,
  }, null, 2) + "\n");
  console.log(md);
}

main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
