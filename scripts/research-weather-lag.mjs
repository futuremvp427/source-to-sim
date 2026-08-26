#!/usr/bin/env node

/**
 * Research-only Kalshi daily-high "dead bucket" lag backtest.
 *
 * Hypothesis: once same-day station observations have already exceeded a
 * bounded temperature bucket by a conservative margin, the bucket cannot win
 * under a monotonic daily-maximum process. If the exchange still offers NO at
 * a sufficiently low executable ask, there may be a short-lived pricing lag.
 *
 * Important limitations:
 * - IEM ASOS/METAR is used only as timestamped public observation evidence.
 *   Kalshi settles from the NWS final Daily Climate Report named in each market.
 * - Primary rule requires the observed maximum to exceed the bucket ceiling by
 *   >= 2 F to reduce one-degree conversion/rounding mismatch risk.
 * - Historical quote reconstruction uses Kalshi's public 1-minute YES-bid
 *   candlesticks. Buying NO is inferred at 1 - YES bid.
 * - This is a one-contract-equivalent price test with 100-contract fee math;
 *   depth/capacity is not proven by candlesticks.
 * - No credentials, orders, previews, or live trading are used.
 */

import { mkdir, writeFile } from "node:fs/promises";

const KALSHI = "https://external-api.kalshi.com/trade-api/v2";
const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const START_DATE = process.env.START_DATE ?? "2026-07-20";
const END_DATE = process.env.END_DATE ?? "2026-08-24";
const CONTRACTS = Number(process.env.CONTRACTS ?? "100");
const QUOTE_MAX_DELAY_SECONDS = Number(process.env.QUOTE_MAX_DELAY_SECONDS ?? "600");
const PRIMARY_MARGIN_F = Number(process.env.PRIMARY_MARGIN_F ?? "2");
const ENTRY_THRESHOLDS = [0.75, 0.8, 0.85, 0.9, 0.95];

const SERIES = [
  {
    series: "KXHIGHLAX",
    station: "LAX",
    icao: "KLAX",
    network: "CA_ASOS",
    timeZone: "America/Los_Angeles",
    label: "Los Angeles",
  },
  {
    series: "KXHIGHTSFO",
    station: "SFO",
    icao: "KSFO",
    network: "CA_ASOS",
    timeZone: "America/Los_Angeles",
    label: "San Francisco",
  },
  {
    series: "KXHIGHMIA",
    station: "MIA",
    icao: "KMIA",
    network: "FL_ASOS",
    timeZone: "America/New_York",
    label: "Miami",
  },
];

const MONTHS = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, { attempts = 5, text = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "source-to-sim-weather-research/1.0" },
      });
      if (response.ok) return text ? response.text() : response.json();
      const body = await response.text();
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
      }
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
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function unixAtUtcDate(isoDate, hour = 0) {
  return Math.floor(Date.parse(`${isoDate}T${String(hour).padStart(2, "0")}:00:00Z`) / 1000);
}

function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function eventDateFromTicker(eventTicker) {
  const match = String(eventTicker ?? "").match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})$/i);
  if (!match) return null;
  const year = `20${match[1]}`;
  const month = MONTHS[match[2].toUpperCase()];
  return month ? `${year}-${month}-${match[3]}` : null;
}

function parseBoundedBucket(market) {
  const raw = `${market.yes_sub_title ?? ""} ${market.subtitle ?? ""}`
    .replace(/°/g, "")
    .replace(/fahrenheit/gi, "F")
    .replace(/\s+/g, " ")
    .trim();

  let match = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:to|-|–)\s*(-?\d+(?:\.\d+)?)\s*(?:F)?/i);
  if (match) {
    const low = Number(match[1]);
    const high = Number(match[2]);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) {
      return { kind: "range", low, upper: high, label: market.yes_sub_title ?? raw };
    }
  }

  match = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:or\s+below|or\s+lower|or\s+less|and\s+below|or\s+under)/i);
  if (match) {
    const upper = Number(match[1]);
    if (Number.isFinite(upper)) return { kind: "below", upper, label: market.yes_sub_title ?? raw };
  }

  return null;
}

function csvRows(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((value) => value.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]));
  });
}

async function fetchObservations(config) {
  const start = ymdParts(START_DATE);
  const endExclusive = ymdParts(addDays(END_DATE, 1));
  const params = new URLSearchParams({
    station: config.station,
    network: config.network,
    data: "tmpf",
    year1: String(start.year),
    month1: String(start.month),
    day1: String(start.day),
    year2: String(endExclusive.year),
    month2: String(endExclusive.month),
    day2: String(endExclusive.day),
    tz: "Etc/UTC",
    format: "onlycomma",
    latlon: "no",
    elev: "no",
    missing: "M",
    trace: "T",
    direct: "no",
  });
  params.append("report_type", "1");
  params.append("report_type", "3");
  params.append("report_type", "4");

  const text = await fetchWithRetry(`${IEM}?${params}`, { text: true });
  const byDate = new Map();
  for (const row of csvRows(text)) {
    if (!row.valid || !row.tmpf || row.tmpf === "M") continue;
    const tempF = Number(row.tmpf);
    if (!Number.isFinite(tempF)) continue;
    const timestamp = Date.parse(`${row.valid.replace(" ", "T")}Z`);
    if (!Number.isFinite(timestamp)) continue;
    const date = localDateKey(new Date(timestamp), config.timeZone);
    if (date < START_DATE || date > END_DATE) continue;
    const list = byDate.get(date) ?? [];
    list.push({ ts: Math.floor(timestamp / 1000), tempF });
    byDate.set(date, list);
  }
  for (const list of byDate.values()) list.sort((a, b) => a.ts - b.ts);
  return byDate;
}

async function fetchSettledMarkets(series) {
  const minSettled = unixAtUtcDate(START_DATE, 0);
  const maxSettled = unixAtUtcDate(addDays(END_DATE, 3), 23);
  const all = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({
      series_ticker: series,
      status: "settled",
      min_settled_ts: String(minSettled),
      max_settled_ts: String(maxSettled),
      limit: "1000",
    });
    if (cursor) params.set("cursor", cursor);
    const data = await fetchWithRetry(`${KALSHI}/markets?${params}`);
    all.push(...(data.markets ?? []));
    cursor = data.cursor || null;
    if (cursor) await sleep(125);
  } while (cursor);
  return all.filter((market) => {
    const date = eventDateFromTicker(market.event_ticker);
    return date && date >= START_DATE && date <= END_DATE;
  });
}

function eventWindowUtc(date, config) {
  // Use Intl to derive UTC timestamps corresponding to local 08:00 and 20:00.
  // Search a small UTC window so DST and timezone offsets are not hardcoded.
  const target = (hour) => {
    const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
    for (let delta = -12; delta <= 12; delta += 1) {
      const candidate = new Date(guess + delta * 3600_000);
      const formatted = new Intl.DateTimeFormat("en-US", {
        timeZone: config.timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(candidate);
      const get = (type) => formatted.find((part) => part.type === type)?.value;
      const candidateDate = `${get("year")}-${get("month")}-${get("day")}`;
      const candidateHour = Number(get("hour")) % 24;
      if (candidateDate === date && candidateHour === hour && get("minute") === "00") {
        return Math.floor(candidate.getTime() / 1000);
      }
    }
    throw new Error(`Could not resolve local ${date} ${hour}:00 in ${config.timeZone}`);
  };
  return { startTs: target(8), endTs: target(20) };
}

async function fetchEventCandles(config, eventTicker, date) {
  const { startTs, endTs } = eventWindowUtc(date, config);
  const params = new URLSearchParams({
    start_ts: String(startTs),
    end_ts: String(endTs),
    period_interval: "1",
  });
  return fetchWithRetry(`${KALSHI}/series/${config.series}/events/${eventTicker}/candlesticks?${params}`);
}

function firstDeadSignal(observations, upper, marginF) {
  let runningMax = -Infinity;
  for (const observation of observations) {
    runningMax = Math.max(runningMax, observation.tempF);
    if (runningMax >= upper + marginF) {
      return { ts: observation.ts, observedMaxF: runningMax };
    }
  }
  return null;
}

function readCloseDollars(side) {
  const raw = side?.close_dollars ?? side?.close ?? null;
  if (raw === null || raw === undefined || raw === "") return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function quoteAfterSignal(candles, signalTs) {
  for (const candle of candles ?? []) {
    const endTs = Number(candle.end_period_ts);
    if (!Number.isFinite(endTs) || endTs < signalTs) continue;
    if (endTs - signalTs > QUOTE_MAX_DELAY_SECONDS) break;
    const yesBid = readCloseDollars(candle.yes_bid);
    if (yesBid === null) continue;
    const noAsk = Math.min(1, Math.max(0, 1 - yesBid));
    return { quoteTs: endTs, yesBid, noAsk, delaySeconds: endTs - signalTs };
  }
  return null;
}

function takerFee(contracts, price) {
  return Math.ceil(0.07 * contracts * price * (1 - price) * 100) / 100;
}

function summarizeTrades(trades, maxNoAsk) {
  const selected = trades.filter((trade) => trade.noAsk <= maxNoAsk);
  const wins = selected.filter((trade) => trade.result === "no").length;
  const losses = selected.length - wins;
  let stake = 0;
  let pnl = 0;
  for (const trade of selected) {
    const fee = takerFee(CONTRACTS, trade.noAsk);
    const cost = CONTRACTS * trade.noAsk + fee;
    const payout = trade.result === "no" ? CONTRACTS : 0;
    stake += cost;
    pnl += payout - cost;
  }
  return {
    maxNoAsk,
    trades: selected.length,
    wins,
    losses,
    winRate: selected.length ? wins / selected.length : null,
    stake,
    pnl,
    roiOnCost: stake ? pnl / stake : null,
  };
}

async function main() {
  if (!/^2026-\d{2}-\d{2}$/.test(START_DATE) || !/^2026-\d{2}-\d{2}$/.test(END_DATE)) {
    throw new Error("This preregistered research script currently expects 2026 ISO dates.");
  }
  if (START_DATE > END_DATE) throw new Error("START_DATE must be <= END_DATE");

  const allTrades = [];
  const diagnostics = [];

  for (const config of SERIES) {
    console.log(`\n=== ${config.label} (${config.series}/${config.icao}) ===`);
    const [observationsByDate, markets] = await Promise.all([
      fetchObservations(config),
      fetchSettledMarkets(config.series),
    ]);
    const events = new Map();
    for (const market of markets) {
      const date = eventDateFromTicker(market.event_ticker);
      if (!date) continue;
      const item = events.get(market.event_ticker) ?? { date, markets: [] };
      item.markets.push(market);
      events.set(market.event_ticker, item);
    }

    console.log(`settled markets=${markets.length}, events=${events.size}, observation-days=${observationsByDate.size}`);

    for (const [eventTicker, event] of [...events.entries()].sort((a, b) => a[1].date.localeCompare(b[1].date))) {
      const observations = observationsByDate.get(event.date) ?? [];
      if (!observations.length) {
        diagnostics.push({ series: config.series, eventTicker, date: event.date, reason: "NO_OBSERVATIONS" });
        continue;
      }

      const candidates = event.markets
        .map((market) => ({ market, bucket: parseBoundedBucket(market) }))
        .filter((item) => item.bucket);
      const signaled = candidates
        .map((item) => ({ ...item, signal: firstDeadSignal(observations, item.bucket.upper, PRIMARY_MARGIN_F) }))
        .filter((item) => item.signal);
      if (!signaled.length) continue;

      let eventCandles;
      try {
        eventCandles = await fetchEventCandles(config, eventTicker, event.date);
      } catch (error) {
        diagnostics.push({ series: config.series, eventTicker, date: event.date, reason: `CANDLE_ERROR:${error.message}` });
        continue;
      }
      await sleep(125);

      const tickers = eventCandles.market_tickers ?? [];
      const candleSets = eventCandles.market_candlesticks ?? [];
      const candlesByTicker = new Map(tickers.map((ticker, index) => [ticker, candleSets[index] ?? []]));

      for (const item of signaled) {
        const candles = candlesByTicker.get(item.market.ticker) ?? [];
        const quote = quoteAfterSignal(candles, item.signal.ts);
        if (!quote) {
          diagnostics.push({
            series: config.series,
            eventTicker,
            date: event.date,
            ticker: item.market.ticker,
            reason: "NO_EXECUTABLE_QUOTE_WITHIN_DELAY",
          });
          continue;
        }
        allTrades.push({
          city: config.label,
          series: config.series,
          station: config.icao,
          date: event.date,
          eventTicker,
          ticker: item.market.ticker,
          bucket: item.bucket.label,
          upperF: item.bucket.upper,
          observedMaxF: item.signal.observedMaxF,
          signalTs: item.signal.ts,
          quoteTs: quote.quoteTs,
          quoteDelaySeconds: quote.delaySeconds,
          yesBid: quote.yesBid,
          noAsk: quote.noAsk,
          result: String(item.market.result ?? "").toLowerCase(),
        });
      }
    }
  }

  const byThreshold = ENTRY_THRESHOLDS.map((threshold) => summarizeTrades(allTrades, threshold));
  const overallWins = allTrades.filter((trade) => trade.result === "no").length;
  const falseDeadSignals = allTrades.filter((trade) => trade.result !== "no");

  const report = {
    generatedAt: new Date().toISOString(),
    researchStatus: "NO_HINDSIGHT_PUBLIC_DATA_BACKTEST",
    strategy: "BUY_NO_AFTER_OBSERVED_MAX_EXCEEDS_BUCKET_CEILING",
    startDate: START_DATE,
    endDate: END_DATE,
    primaryMarginF: PRIMARY_MARGIN_F,
    quoteMaxDelaySeconds: QUOTE_MAX_DELAY_SECONDS,
    contractsForFeeMath: CONTRACTS,
    sources: {
      kalshi: "public settled markets + public 1-minute event candlesticks",
      observations: "IEM ASOS/METAR archive (public timestamped observations)",
      settlement: "Kalshi market result field; market rules use NWS Daily Climate Report",
    },
    limitations: [
      "IEM observations are not themselves the settlement source; a conservative 2 F margin is used but does not make settlement-source risk zero.",
      "Candlesticks reconstruct YES bid, from which NO ask is inferred as 1 - YES bid; order-book depth is not available in the candle.",
      "The test does not assume fills beyond the displayed price and does not claim scalable capacity.",
      "This stage tests only the same-day dead-bucket lag hypothesis, not NBM probabilistic forecasting.",
    ],
    candidateQuotes: allTrades.length,
    candidateWins: overallWins,
    candidateWinRate: allTrades.length ? overallWins / allTrades.length : null,
    falseDeadSignals,
    thresholds: byThreshold,
    trades: allTrades,
    diagnostics,
  };

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-lag-backtest.json", `${JSON.stringify(report, null, 2)}\n`);

  const lines = [
    "# Weather Lag Backtest",
    "",
    `Window: ${START_DATE} through ${END_DATE}`,
    `Primary signal: observed station max >= bucket ceiling + ${PRIMARY_MARGIN_F} F`,
    `Executable quote allowance: <= ${QUOTE_MAX_DELAY_SECONDS}s after signal`,
    "",
    `Candidate executable quotes: **${allTrades.length}**`,
    `Candidate outcomes resolving NO: **${overallWins}/${allTrades.length || 0}**${allTrades.length ? ` (${(100 * overallWins / allTrades.length).toFixed(1)}%)` : ""}`,
    `False dead signals: **${falseDeadSignals.length}**`,
    "",
    "## Price-threshold results (100-contract taker-fee math)",
    "",
    "| Max NO ask | Trades | Wins | Losses | Win rate | Net P/L | ROI on cost |",
    "|---:|---:|---:|---:|---:|---:|---:|",
    ...byThreshold.map((row) => `| ${(row.maxNoAsk * 100).toFixed(0)}c | ${row.trades} | ${row.wins} | ${row.losses} | ${row.winRate === null ? "n/a" : `${(row.winRate * 100).toFixed(1)}%`} | $${row.pnl.toFixed(2)} | ${row.roiOnCost === null ? "n/a" : `${(row.roiOnCost * 100).toFixed(2)}%`} |`),
    "",
    "## Interpretation guardrails",
    "",
    "- No live orders or credentials were used.",
    "- IEM observations are timestamped public evidence but Kalshi settles from the NWS final CLI named in the market rules.",
    "- A 2 F exceedance margin is deliberately conservative but does not eliminate all settlement-source/measurement risk.",
    "- No order-book depth/capacity claim is made from candlesticks.",
    "- If no meaningful trades remain below 90c after fees, this simple lag hypothesis should be considered weak and we should not build a production bot around it.",
  ];
  await writeFile("research-output/weather-lag-backtest.md", `${lines.join("\n")}\n`);

  console.log("\n" + lines.join("\n"));
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
