#!/usr/bin/env node

/**
 * Research-only NBM-vs-Kalshi daily-high backtest.
 *
 * Preregistered design:
 * - Forecast: NOAA NBM probabilistic text bulletin, 13Z cycle from the day
 *   BEFORE the target weather date. For a 13Z bulletin, FHR 35 / UTC 00 is
 *   the next local-day daytime maximum forecast used here.
 * - Model: Normal approximation from NBM QMD TXNMN mean and TXNSD standard
 *   deviation. Integer settlement buckets use +/-0.5 F continuity bounds.
 * - Price: first public Kalshi 1-minute BBO candle at/after 16:00Z on the
 *   forecast run date, no more than 30 minutes late. This is deliberately
 *   after the 13Z NBP bulletin's normal public publication time.
 * - One trade maximum per station-day to preserve independent episode count.
 * - Parameter selection uses TRAIN only. OOS is never used to select a rule.
 * - No credentials, order submission, authenticated previews, or live trading.
 */

import { mkdir, writeFile } from "node:fs/promises";

const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
const NBM = "https://noaa-nbm-grib2-pds.s3.amazonaws.com";
const START_DATE = process.env.START_DATE ?? "2026-07-20";
const END_DATE = process.env.END_DATE ?? "2026-08-24";
const TRAIN_END = process.env.TRAIN_END ?? "2026-08-11";
const OOS_START = process.env.OOS_START ?? "2026-08-12";
const CONTRACTS = Number(process.env.CONTRACTS ?? "100");
const QUOTE_MAX_DELAY_SECONDS = Number(process.env.QUOTE_MAX_DELAY_SECONDS ?? "1800");
const MIN_TRAIN_TRADES = Number(process.env.MIN_TRAIN_TRADES ?? "20");
const MIN_OOS_TRADES = Number(process.env.MIN_OOS_TRADES ?? "10");

const CONFIDENCE_THRESHOLDS = [0.7, 0.75, 0.8, 0.85, 0.9];
const EDGE_THRESHOLDS = [0.05, 0.1, 0.15, 0.2];
const MAX_ASKS = [0.8, 0.85, 0.9, 0.95];

const SERIES = [
  { series: "KXHIGHLAX", icao: "KLAX", label: "Los Angeles" },
  { series: "KXHIGHTSFO", icao: "KSFO", label: "San Francisco" },
  { series: "KXHIGHMIA", icao: "KMIA", label: "Miami" },
];

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, { attempts = 5 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "source-to-sim-weather-research/1.0" } });
      if (response.ok) return response;
      const body = await response.text();
      if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 250)}`);
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
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
function compactDate(isoDate) { return isoDate.replaceAll("-", ""); }
function unixAtUtc(isoDate, hour, minute = 0) { return Math.floor(Date.parse(`${isoDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) / 1000); }
function eventDateFromTicker(eventTicker) {
  const match = String(eventTicker ?? "").match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})$/i);
  if (!match) return null;
  const month = MONTHS[match[2].toUpperCase()];
  return month ? `20${match[1]}-${month}-${match[3]}` : null;
}

function parseBucket(market) {
  const raw = `${market.yes_sub_title ?? ""} ${market.subtitle ?? ""}`.replace(/°/g, "").replace(/fahrenheit/gi, "F").replace(/\s+/g, " ").trim();
  let m = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:to|-|–)\s*(-?\d+(?:\.\d+)?)\s*(?:F)?/i);
  if (m) {
    const low = Number(m[1]); const high = Number(m[2]);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) return { kind: "range", low, high, label: market.yes_sub_title ?? raw };
  }
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:or\s+below|or\s+lower|or\s+less|and\s+below|or\s+under)/i);
  if (m) return { kind: "below", value: Number(m[1]), label: market.yes_sub_title ?? raw };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:or\s+above|or\s+higher|or\s+more|and\s+above)/i);
  if (m) return { kind: "above", value: Number(m[1]), label: market.yes_sub_title ?? raw };
  return null;
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}
function normalCdf(x, mean, sd) {
  if (!Number.isFinite(sd) || sd <= 0) return x < mean ? 0 : 1;
  return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
}
function bucketProbability(bucket, mean, sd) {
  if (bucket.kind === "range") return Math.max(0, Math.min(1, normalCdf(bucket.high + 0.5, mean, sd) - normalCdf(bucket.low - 0.5, mean, sd)));
  if (bucket.kind === "below") return normalCdf(bucket.value + 0.5, mean, sd);
  return 1 - normalCdf(bucket.value - 0.5, mean, sd);
}

function lineValues(block, key) {
  const line = block.split(/\r?\n/).find((row) => row.trimStart().startsWith(key));
  if (!line) return null;
  return line.slice(line.indexOf(key) + key.length).match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? null;
}
function stationBlock(text, icao) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trimStart().startsWith(`${icao}    NBM`));
  if (index < 0) return null;
  return lines.slice(index, index + 35).join("\n");
}
function parseForecastForStation(text, icao) {
  const block = stationBlock(text, icao);
  if (!block) return null;
  const fhr = lineValues(block, "FHR");
  const mean = lineValues(block, "TXNMN");
  const sd = lineValues(block, "TXNSD");
  const p10 = lineValues(block, "TXNP1");
  const p25 = lineValues(block, "TXNP2");
  const p50 = lineValues(block, "TXNP5");
  const p75 = lineValues(block, "TXNP7");
  const p90 = lineValues(block, "TXNP9");
  if (![fhr, mean, sd, p10, p25, p50, p75, p90].every(Boolean)) return null;
  const index = fhr.findIndex((value) => value === 35);
  if (index < 0) return null;
  const values = { mean: mean[index], sd: sd[index], p10: p10[index], p25: p25[index], p50: p50[index], p75: p75[index], p90: p90[index] };
  if (Object.values(values).some((value) => !Number.isFinite(value) || value === -99)) return null;
  return { ...values, forecastHour: 35 };
}

async function fetchNbmForecasts(runDate) {
  const url = `${NBM}/blend.${compactDate(runDate)}/13/text/blend_nbptx.t13z`;
  const response = await fetchWithRetry(url);
  const text = await response.text();
  const forecasts = {};
  for (const config of SERIES) forecasts[config.icao] = parseForecastForStation(text, config.icao);
  return { url, forecasts };
}

async function fetchSettledMarkets(series) {
  const params = new URLSearchParams({ series_ticker: series, status: "settled", min_settled_ts: String(unixAtUtc(START_DATE, 0)), max_settled_ts: String(unixAtUtc(addDays(END_DATE, 3), 23)), limit: "1000" });
  const response = await fetchWithRetry(`${KALSHI}/markets?${params}`);
  const data = await response.json();
  return (data.markets ?? []).filter((market) => {
    const date = eventDateFromTicker(market.event_ticker);
    return date && date >= START_DATE && date <= END_DATE;
  });
}

async function fetchEventCandles(config, eventTicker, targetDate) {
  const runDate = addDays(targetDate, -1);
  const startTs = unixAtUtc(runDate, 16, 0);
  const endTs = startTs + QUOTE_MAX_DELAY_SECONDS;
  const params = new URLSearchParams({ start_ts: String(startTs), end_ts: String(endTs), period_interval: "1" });
  const response = await fetchWithRetry(`${KALSHI}/series/${config.series}/events/${eventTicker}/candlesticks?${params}`);
  return { payload: await response.json(), startTs, runDate };
}
function closeDollars(side) {
  const raw = side?.close_dollars ?? side?.close ?? null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function quoteAtOrAfter(candles, targetTs) {
  for (const candle of candles ?? []) {
    const ts = Number(candle.end_period_ts);
    if (!Number.isFinite(ts) || ts < targetTs) continue;
    if (ts - targetTs > QUOTE_MAX_DELAY_SECONDS) break;
    const yesAsk = closeDollars(candle.yes_ask);
    const yesBid = closeDollars(candle.yes_bid);
    if (yesAsk === null || yesBid === null) continue;
    return { ts, yesAsk, yesBid, noAsk: Math.max(0, Math.min(1, 1 - yesBid)), delaySeconds: ts - targetTs };
  }
  return null;
}

function takerFee(contracts, price) { return Math.ceil(0.07 * contracts * price * (1 - price) * 100) / 100; }
function tradePnl(trade) {
  const fee = takerFee(CONTRACTS, trade.ask);
  const cost = CONTRACTS * trade.ask + fee;
  const won = trade.side === trade.result;
  return { won, fee, cost, pnl: (won ? CONTRACTS : 0) - cost };
}

function candidateForMarket(row) {
  const yes = { ...row, side: "yes", modelProbability: row.modelYesProbability, ask: row.yesAsk, edge: row.modelYesProbability - row.yesAsk };
  const noProbability = 1 - row.modelYesProbability;
  const no = { ...row, side: "no", modelProbability: noProbability, ask: row.noAsk, edge: noProbability - row.noAsk };
  return [yes, no];
}
function scoreRule(rows, rule) {
  const byEvent = new Map();
  for (const row of rows) {
    for (const candidate of candidateForMarket(row)) {
      if (candidate.modelProbability < rule.minConfidence) continue;
      if (candidate.edge < rule.minEdge) continue;
      if (candidate.ask > rule.maxAsk) continue;
      const current = byEvent.get(candidate.eventTicker);
      if (!current || candidate.edge > current.edge || (candidate.edge === current.edge && candidate.ask < current.ask)) byEvent.set(candidate.eventTicker, candidate);
    }
  }
  const trades = [...byEvent.values()];
  let wins = 0; let cost = 0; let pnl = 0;
  for (const trade of trades) {
    const scored = tradePnl(trade);
    if (scored.won) wins += 1;
    cost += scored.cost; pnl += scored.pnl;
  }
  return { ...rule, trades: trades.length, wins, losses: trades.length - wins, winRate: trades.length ? wins / trades.length : null, pnl, cost, roi: cost ? pnl / cost : null, selectedTrades: trades };
}

async function main() {
  const forecastCache = new Map();
  const diagnostics = [];
  const rows = [];

  async function forecastForDate(targetDate, icao) {
    const runDate = addDays(targetDate, -1);
    if (!forecastCache.has(runDate)) {
      process.stdout.write(`NBM ${runDate} 13Z ... `);
      try {
        forecastCache.set(runDate, await fetchNbmForecasts(runDate));
        console.log("ok");
      } catch (error) {
        forecastCache.set(runDate, { error: error.message, forecasts: {} });
        console.log(`failed: ${error.message}`);
      }
    }
    return forecastCache.get(runDate)?.forecasts?.[icao] ?? null;
  }

  for (const config of SERIES) {
    console.log(`\n=== ${config.label} (${config.series}/${config.icao}) ===`);
    const markets = await fetchSettledMarkets(config.series);
    const events = new Map();
    for (const market of markets) {
      const date = eventDateFromTicker(market.event_ticker);
      if (!date) continue;
      const event = events.get(market.event_ticker) ?? { date, markets: [] };
      event.markets.push(market); events.set(market.event_ticker, event);
    }
    console.log(`events=${events.size}, markets=${markets.length}`);

    for (const [eventTicker, event] of [...events.entries()].sort((a, b) => a[1].date.localeCompare(b[1].date))) {
      const forecast = await forecastForDate(event.date, config.icao);
      if (!forecast) { diagnostics.push({ city: config.label, date: event.date, eventTicker, reason: "NO_NBM_FORECAST" }); continue; }
      let candle;
      try { candle = await fetchEventCandles(config, eventTicker, event.date); }
      catch (error) { diagnostics.push({ city: config.label, date: event.date, eventTicker, reason: `CANDLE_ERROR:${error.message}` }); continue; }
      await sleep(100);
      const tickers = candle.payload.market_tickers ?? [];
      const sets = candle.payload.market_candlesticks ?? [];
      const byTicker = new Map(tickers.map((ticker, index) => [ticker, sets[index] ?? []]));
      for (const market of event.markets) {
        const bucket = parseBucket(market);
        if (!bucket) continue;
        const quote = quoteAtOrAfter(byTicker.get(market.ticker), candle.startTs);
        if (!quote) continue;
        rows.push({
          split: event.date <= TRAIN_END ? "TRAIN" : event.date >= OOS_START ? "OOS" : "GAP",
          city: config.label, station: config.icao, date: event.date, forecastRunDate: candle.runDate, eventTicker, ticker: market.ticker,
          bucket: bucket.label, bucketSpec: bucket, result: String(market.result ?? "").toLowerCase(),
          forecast, modelYesProbability: bucketProbability(bucket, forecast.mean, forecast.sd),
          yesAsk: quote.yesAsk, yesBid: quote.yesBid, noAsk: quote.noAsk, quoteTs: quote.ts, quoteDelaySeconds: quote.delaySeconds,
        });
      }
    }
  }

  const train = rows.filter((row) => row.split === "TRAIN");
  const oos = rows.filter((row) => row.split === "OOS");
  const rules = [];
  for (const minConfidence of CONFIDENCE_THRESHOLDS) for (const minEdge of EDGE_THRESHOLDS) for (const maxAsk of MAX_ASKS) rules.push({ minConfidence, minEdge, maxAsk });
  const trainScores = rules.map((rule) => scoreRule(train, rule));
  const qualified = trainScores.filter((score) => score.trades >= MIN_TRAIN_TRADES && score.winRate >= 0.75 && score.pnl > 0 && score.roi > 0);
  qualified.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity) || b.trades - a.trades || b.winRate - a.winRate);
  const selectedTrain = qualified[0] ?? null;
  const selectedOos = selectedTrain ? scoreRule(oos, { minConfidence: selectedTrain.minConfidence, minEdge: selectedTrain.minEdge, maxAsk: selectedTrain.maxAsk }) : null;
  const oosPass = Boolean(selectedOos && selectedOos.trades >= MIN_OOS_TRADES && selectedOos.winRate >= 0.75 && selectedOos.pnl > 0 && selectedOos.roi > 0);

  // Baseline model-vs-market correctness, without selecting a trading rule.
  const eventRows = new Map();
  for (const row of rows) {
    const list = eventRows.get(row.eventTicker) ?? [];
    list.push(row); eventRows.set(row.eventTicker, list);
  }
  let modelTopCorrect = 0; let marketTopCorrect = 0; let completeEvents = 0;
  for (const list of eventRows.values()) {
    if (!list.length) continue;
    const modelTop = [...list].sort((a, b) => b.modelYesProbability - a.modelYesProbability)[0];
    const marketTop = [...list].sort((a, b) => ((b.yesAsk + b.yesBid) / 2) - ((a.yesAsk + a.yesBid) / 2))[0];
    const winner = list.find((row) => row.result === "yes");
    if (!winner) continue;
    completeEvents += 1;
    if (modelTop.ticker === winner.ticker) modelTopCorrect += 1;
    if (marketTop.ticker === winner.ticker) marketTopCorrect += 1;
  }

  const report = {
    generatedAt: new Date().toISOString(), status: oosPass ? "OOS_PASS_REQUIRES_FORWARD_PAPER" : "NO_PROVEN_EDGE",
    startDate: START_DATE, endDate: END_DATE, trainEnd: TRAIN_END, oosStart: OOS_START,
    forecastProtocol: "previous-day NOAA NBM NBP 13Z; FHR35 next-day daytime maximum",
    priceProtocol: "first Kalshi public 1-minute BBO at/after 16:00Z on forecast run date, <=30m delay",
    probabilityModel: "Normal(mean=TXNMN, sd=TXNSD), integer bucket continuity +/-0.5F",
    marketRows: rows.length, trainRows: train.length, oosRows: oos.length, independentEvents: completeEvents,
    modelTopAccuracy: completeEvents ? modelTopCorrect / completeEvents : null,
    marketTopAccuracy: completeEvents ? marketTopCorrect / completeEvents : null,
    selectionConstraint: { minTrainTrades: MIN_TRAIN_TRADES, minTrainWinRate: 0.75, positivePnl: true, positiveRoi: true },
    oosAcceptance: { minOosTrades: MIN_OOS_TRADES, minOosWinRate: 0.75, positivePnl: true, positiveRoi: true },
    selectedTrain: selectedTrain ? { ...selectedTrain, selectedTrades: undefined } : null,
    selectedOos: selectedOos ? { ...selectedOos, selectedTrades: undefined } : null,
    oosPass,
    selectedOosTrades: selectedOos?.selectedTrades ?? [],
    topTrainRules: trainScores.sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity)).slice(0, 20).map(({ selectedTrades, ...score }) => score),
    forecastRunsFetched: forecastCache.size,
    diagnostics,
    limitations: [
      "This uses only KLAX, KSFO, and KMIA and a short 2026 summer window.",
      "NBM maximum temperature at FHR35/00Z covers the primary daytime max window; it is not a guarantee of the final NWS CLI value.",
      "The Normal approximation uses NBM QMD mean/SD and does not exploit the full non-Gaussian percentile shape.",
      "Candlestick BBO prices establish a displayed quote, not depth or scalable fill capacity.",
      "Any OOS pass is only sufficient to justify a larger prospective frozen-rule paper test, never live execution.",
    ],
  };

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-nbm-oos.json", `${JSON.stringify(report, null, 2)}\n`);
  const pct = (v) => v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`;
  const money = (v) => v === null || v === undefined ? "n/a" : `$${v.toFixed(2)}`;
  const lines = [
    "# Weather NBM Probabilistic OOS Test", "",
    `Window: ${START_DATE} through ${END_DATE}`, `Train: through ${TRAIN_END}`, `OOS: ${OOS_START} through ${END_DATE}`, "",
    `Market rows with forecast + quote: **${rows.length}**`, `Independent settled events: **${completeEvents}**`,
    `NBM top-bucket accuracy: **${pct(report.modelTopAccuracy)}**`, `Market top-bucket accuracy at entry snapshot: **${pct(report.marketTopAccuracy)}**`, "",
    selectedTrain ? `Frozen rule from TRAIN: confidence >= ${pct(selectedTrain.minConfidence)}, edge >= ${pct(selectedTrain.minEdge)}, ask <= ${pct(selectedTrain.maxAsk)}; ${selectedTrain.trades} trades, ${pct(selectedTrain.winRate)} wins, ${money(selectedTrain.pnl)} P/L, ${pct(selectedTrain.roi)} ROI` : "Frozen rule from TRAIN: **NONE met the preregistered >=75% / positive-P&L / minimum-trade gate**",
    selectedOos ? `OOS result: ${selectedOos.trades} trades, ${pct(selectedOos.winRate)} wins, ${money(selectedOos.pnl)} P/L, ${pct(selectedOos.roi)} ROI` : "OOS result: **not entered because no training rule qualified**",
    `OOS acceptance gate: **${oosPass ? "PASS" : "FAIL"}**`, "",
    oosPass ? "Decision: do not deploy; advance only to a larger prospective frozen-rule paper test." : "Decision: this bounded NBM hypothesis did not establish the requested high-win-rate edge. Do not build/deploy a bot around it.",
  ];
  await writeFile("research-output/weather-nbm-oos.md", `${lines.join("\n")}\n`);
  console.log("\n" + lines.join("\n"));
}

main().catch((error) => { console.error(error?.stack ?? error); process.exitCode = 1; });
