#!/usr/bin/env node

/**
 * Research-only late-day daily-high strategy falsification test.
 *
 * We use timestamped ASOS/METAR observations available by the decision time,
 * identify the Kalshi bucket containing the observed maximum so far, require
 * that the maximum has not increased for a fixed amount of time, and evaluate
 * buying YES at the contemporaneous public YES ask.
 *
 * Parameter selection is confined to an earlier training period. The selected
 * rule is then frozen and evaluated on later out-of-sample dates.
 * No credentials or orders are used.
 */

import { mkdir, writeFile } from "node:fs/promises";

const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const START_DATE = process.env.START_DATE ?? "2026-07-20";
const END_DATE = process.env.END_DATE ?? "2026-08-24";
const TRAIN_END = process.env.TRAIN_END ?? "2026-08-11";
const OOS_START = process.env.OOS_START ?? "2026-08-12";
const CONTRACTS = Number(process.env.CONTRACTS ?? "100");
const QUOTE_MAX_DELAY_SECONDS = Number(process.env.QUOTE_MAX_DELAY_SECONDS ?? "300");
const MIN_TRAIN_TRADES = Number(process.env.MIN_TRAIN_TRADES ?? "15");
const MIN_OOS_TRADES = Number(process.env.MIN_OOS_TRADES ?? "10");

const HOURS = [15, 16, 17, 18];
const STAGNATION_MINUTES = [60, 120, 180];
const MAX_YES_ASKS = [0.6, 0.7, 0.75, 0.8, 0.85, 0.9];

const SERIES = [
  { series: "KXHIGHLAX", station: "LAX", icao: "KLAX", network: "CA_ASOS", timeZone: "America/Los_Angeles", label: "Los Angeles" },
  { series: "KXHIGHTSFO", station: "SFO", icao: "KSFO", network: "CA_ASOS", timeZone: "America/Los_Angeles", label: "San Francisco" },
  { series: "KXHIGHMIA", station: "MIA", icao: "KMIA", network: "FL_ASOS", timeZone: "America/New_York", label: "Miami" },
];

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, { attempts = 5, text = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "source-to-sim-weather-research/1.0" } });
      if (response.ok) return text ? response.text() : response.json();
      const body = await response.text();
      if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 250)}`);
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(5000, 350 * 2 ** (attempt - 1)));
  }
  throw lastError;
}

function ymdParts(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return { year, month, day };
}
function addDays(isoDate, days) {
  const { year, month, day } = ymdParts(isoDate);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function unixAtUtcDate(isoDate, hour = 0) {
  return Math.floor(Date.parse(`${isoDate}T${String(hour).padStart(2, "0")}:00:00Z`) / 1000);
}
function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}
function eventDateFromTicker(eventTicker) {
  const match = String(eventTicker ?? "").match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})$/i);
  if (!match) return null;
  const month = MONTHS[match[2].toUpperCase()];
  return month ? `20${match[1]}-${month}-${match[3]}` : null;
}
function localTimestamp(date, hour, timeZone) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  for (let delta = -12; delta <= 12; delta += 1) {
    const candidate = new Date(guess + delta * 3600_000);
    const parts = localParts(candidate, timeZone);
    if (parts.date === date && parts.hour === hour && parts.minute === 0) return Math.floor(candidate.getTime() / 1000);
  }
  throw new Error(`Cannot resolve ${date} ${hour}:00 ${timeZone}`);
}
function csvRows(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((v) => v.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]));
  });
}

async function fetchObservations(config) {
  const start = ymdParts(START_DATE);
  const endExclusive = ymdParts(addDays(END_DATE, 1));
  const params = new URLSearchParams({ station: config.station, network: config.network, data: "tmpf", year1: String(start.year), month1: String(start.month), day1: String(start.day), year2: String(endExclusive.year), month2: String(endExclusive.month), day2: String(endExclusive.day), tz: "Etc/UTC", format: "onlycomma", latlon: "no", elev: "no", missing: "M", trace: "T", direct: "no" });
  params.append("report_type", "1"); params.append("report_type", "3"); params.append("report_type", "4");
  const text = await fetchWithRetry(`${IEM}?${params}`, { text: true });
  const byDate = new Map();
  for (const row of csvRows(text)) {
    const tempF = Number(row.tmpf);
    if (!row.valid || !Number.isFinite(tempF)) continue;
    const ts = Math.floor(Date.parse(`${row.valid.replace(" ", "T")}Z`) / 1000);
    if (!Number.isFinite(ts)) continue;
    const date = localParts(new Date(ts * 1000), config.timeZone).date;
    if (date < START_DATE || date > END_DATE) continue;
    const list = byDate.get(date) ?? [];
    list.push({ ts, tempF }); byDate.set(date, list);
  }
  for (const list of byDate.values()) list.sort((a, b) => a.ts - b.ts);
  return byDate;
}

async function fetchSettledMarkets(series) {
  const params = new URLSearchParams({ series_ticker: series, status: "settled", min_settled_ts: String(unixAtUtcDate(START_DATE)), max_settled_ts: String(unixAtUtcDate(addDays(END_DATE, 3), 23)), limit: "1000" });
  const data = await fetchWithRetry(`${KALSHI}/markets?${params}`);
  return (data.markets ?? []).filter((market) => {
    const date = eventDateFromTicker(market.event_ticker);
    return date && date >= START_DATE && date <= END_DATE;
  });
}

function parseBucket(market) {
  const raw = `${market.yes_sub_title ?? ""} ${market.subtitle ?? ""}`.replace(/°/g, "").replace(/fahrenheit/gi, "F").replace(/\s+/g, " ").trim();
  let m = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:to|-|–)\s*(-?\d+(?:\.\d+)?)\s*(?:F)?/i);
  if (m) return { low: Number(m[1]), high: Number(m[2]), label: market.yes_sub_title ?? raw };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:or\s+below|or\s+lower|or\s+less|and\s+below|or\s+under)/i);
  if (m) return { low: -Infinity, high: Number(m[1]), label: market.yes_sub_title ?? raw };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:or\s+above|or\s+higher|or\s+more|and\s+above)/i);
  if (m) return { low: Number(m[1]), high: Infinity, label: market.yes_sub_title ?? raw };
  return null;
}

function findBucketForValue(markets, value) {
  const candidates = markets.map((market) => ({ market, bucket: parseBucket(market) })).filter((x) => x.bucket && value >= x.bucket.low && value <= x.bucket.high);
  return candidates.length === 1 ? candidates[0] : null;
}

function maxStateAt(observations, ts) {
  let max = -Infinity;
  let lastIncreaseTs = null;
  for (const obs of observations) {
    if (obs.ts > ts) break;
    if (obs.tempF > max) { max = obs.tempF; lastIncreaseTs = obs.ts; }
  }
  return Number.isFinite(max) && lastIncreaseTs ? { maxF: max, lastIncreaseTs } : null;
}

function closeDollars(side) {
  const raw = side?.close_dollars ?? side?.close ?? null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function fetchEventCandles(config, eventTicker, date) {
  const startTs = localTimestamp(date, 14, config.timeZone);
  const endTs = localTimestamp(date, 19, config.timeZone);
  const params = new URLSearchParams({ start_ts: String(startTs), end_ts: String(endTs), period_interval: "1" });
  return fetchWithRetry(`${KALSHI}/series/${config.series}/events/${eventTicker}/candlesticks?${params}`);
}

function quoteAtOrAfter(candles, targetTs) {
  for (const candle of candles ?? []) {
    const ts = Number(candle.end_period_ts);
    if (!Number.isFinite(ts) || ts < targetTs) continue;
    if (ts - targetTs > QUOTE_MAX_DELAY_SECONDS) break;
    const yesAsk = closeDollars(candle.yes_ask);
    if (yesAsk === null) continue;
    return { ts, yesAsk, delaySeconds: ts - targetTs };
  }
  return null;
}

function takerFee(contracts, price) { return Math.ceil(0.07 * contracts * price * (1 - price) * 100) / 100; }
function score(trades, rule) {
  const selected = trades.filter((t) => t.hour === rule.hour && t.stagnationMinutes >= rule.minStagnation && t.yesAsk <= rule.maxYesAsk);
  const wins = selected.filter((t) => t.result === "yes").length;
  const losses = selected.length - wins;
  let cost = 0; let pnl = 0;
  for (const t of selected) {
    const fee = takerFee(CONTRACTS, t.yesAsk);
    const tradeCost = CONTRACTS * t.yesAsk + fee;
    cost += tradeCost;
    pnl += (t.result === "yes" ? CONTRACTS : 0) - tradeCost;
  }
  return { ...rule, trades: selected.length, wins, losses, winRate: selected.length ? wins / selected.length : null, pnl, cost, roi: cost ? pnl / cost : null };
}

async function main() {
  const candidateRows = [];
  const diagnostics = [];

  for (const config of SERIES) {
    console.log(`\n=== ${config.label} ===`);
    const [obsByDate, markets] = await Promise.all([fetchObservations(config), fetchSettledMarkets(config.series)]);
    const events = new Map();
    for (const market of markets) {
      const date = eventDateFromTicker(market.event_ticker);
      if (!date) continue;
      const e = events.get(market.event_ticker) ?? { date, markets: [] };
      e.markets.push(market); events.set(market.event_ticker, e);
    }
    console.log(`events=${events.size}, markets=${markets.length}, obs-days=${obsByDate.size}`);

    for (const [eventTicker, event] of [...events.entries()].sort((a, b) => a[1].date.localeCompare(b[1].date))) {
      const observations = obsByDate.get(event.date) ?? [];
      if (!observations.length) continue;
      let candlePayload;
      try { candlePayload = await fetchEventCandles(config, eventTicker, event.date); }
      catch (error) { diagnostics.push({ eventTicker, date: event.date, reason: `CANDLE_ERROR:${error.message}` }); continue; }
      await sleep(125);
      const candlesByTicker = new Map((candlePayload.market_tickers ?? []).map((ticker, index) => [ticker, candlePayload.market_candlesticks?.[index] ?? []]));

      for (const hour of HOURS) {
        const decisionTs = localTimestamp(event.date, hour, config.timeZone);
        const state = maxStateAt(observations, decisionTs);
        if (!state) continue;
        const bucket = findBucketForValue(event.markets, state.maxF);
        if (!bucket) { diagnostics.push({ eventTicker, date: event.date, hour, reason: "NO_UNIQUE_BUCKET_FOR_OBSERVED_MAX", maxF: state.maxF }); continue; }
        const quote = quoteAtOrAfter(candlesByTicker.get(bucket.market.ticker), decisionTs);
        if (!quote) continue;
        candidateRows.push({
          split: event.date <= TRAIN_END ? "TRAIN" : event.date >= OOS_START ? "OOS" : "GAP",
          city: config.label, station: config.icao, date: event.date, eventTicker, ticker: bucket.market.ticker,
          hour, observedMaxF: state.maxF, stagnationMinutes: (decisionTs - state.lastIncreaseTs) / 60,
          bucket: bucket.bucket.label, yesAsk: quote.yesAsk, quoteDelaySeconds: quote.delaySeconds,
          result: String(bucket.market.result ?? "").toLowerCase(),
        });
      }
    }
  }

  const train = candidateRows.filter((t) => t.split === "TRAIN");
  const oos = candidateRows.filter((t) => t.split === "OOS");
  const grid = [];
  for (const hour of HOURS) for (const minStagnation of STAGNATION_MINUTES) for (const maxYesAsk of MAX_YES_ASKS) grid.push({ hour, minStagnation, maxYesAsk });
  const trainScores = grid.map((rule) => score(train, rule));
  const eligible = trainScores.filter((r) => r.trades >= MIN_TRAIN_TRADES && r.winRate >= 0.75 && r.pnl > 0);
  eligible.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity) || b.trades - a.trades || a.maxYesAsk - b.maxYesAsk);
  const selectedTrain = eligible[0] ?? null;
  const selectedOos = selectedTrain ? score(oos, selectedTrain) : null;
  const oosPass = Boolean(selectedOos && selectedOos.trades >= MIN_OOS_TRADES && selectedOos.winRate >= 0.75 && selectedOos.pnl > 0 && selectedOos.roi > 0);

  const report = {
    generatedAt: new Date().toISOString(), startDate: START_DATE, endDate: END_DATE, trainEnd: TRAIN_END, oosStart: OOS_START,
    candidateRows: candidateRows.length, trainCandidates: train.length, oosCandidates: oos.length,
    selectionConstraint: { minTrainTrades: MIN_TRAIN_TRADES, minTrainWinRate: 0.75, positiveTrainPnl: true },
    oosAcceptance: { minOosTrades: MIN_OOS_TRADES, minOosWinRate: 0.75, positiveOosPnl: true, positiveOosRoi: true },
    selectedTrain, selectedOos, oosPass,
    topTrainRules: trainScores.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity)).slice(0, 15),
    candidateData: candidateRows,
    diagnostics,
    limitations: [
      "IEM ASOS/METAR observations are timestamped public data but the final Kalshi settlement source is the NWS Daily Climate Report.",
      "Only three airport-station series (KLAX, KSFO, KMIA) are tested.",
      "One-minute candlestick YES ask is used as the reconstructed executable price; depth and fill capacity are not proven.",
      "The training period is small, so even a passing OOS result would require a larger forward paper sample before any deployment decision.",
    ],
  };

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-late-day-oos.json", `${JSON.stringify(report, null, 2)}\n`);
  const f = (v) => v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`;
  const money = (v) => v === null || v === undefined ? "n/a" : `$${v.toFixed(2)}`;
  const lines = [
    "# Weather Late-Day OOS Test", "",
    `Train: ${START_DATE} through ${TRAIN_END}`, `OOS: ${OOS_START} through ${END_DATE}`, "",
    `Candidate decision rows: **${candidateRows.length}** (train ${train.length}, OOS ${oos.length})`, "",
    selectedTrain ? `Selected train rule: **${selectedTrain.hour}:00 local, max unchanged >= ${selectedTrain.minStagnation} min, YES ask <= ${(selectedTrain.maxYesAsk * 100).toFixed(0)}c**` : "Selected train rule: **NONE met the preregistered minimums**",
    selectedTrain ? `Train: ${selectedTrain.trades} trades, ${f(selectedTrain.winRate)} wins, ${money(selectedTrain.pnl)} P/L, ${f(selectedTrain.roi)} ROI` : "",
    selectedOos ? `Frozen OOS: ${selectedOos.trades} trades, ${f(selectedOos.winRate)} wins, ${money(selectedOos.pnl)} P/L, ${f(selectedOos.roi)} ROI` : "Frozen OOS: not run because no training rule qualified.",
    `OOS acceptance gate: **${oosPass ? "PASS" : "FAIL"}**`, "",
    "Acceptance requires >=75% OOS win rate, positive OOS P/L/ROI after taker fees, and the minimum OOS trade count.",
    "A pass is not permission for live trading; it only justifies a larger forward paper test.",
  ].filter(Boolean);
  await writeFile("research-output/weather-late-day-oos.md", `${lines.join("\n")}\n`);
  console.log("\n" + lines.join("\n"));
}

main().catch((error) => { console.error(error?.stack ?? error); process.exitCode = 1; });
