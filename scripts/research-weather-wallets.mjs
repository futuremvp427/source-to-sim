#!/usr/bin/env node

/**
 * Research-only reverse engineering of public Polymarket weather wallets.
 * Uses only public Data API trade history plus public IEM station observations.
 * No credentials, orders, previews, or live trading.
 */

import { mkdir, writeFile } from "node:fs/promises";

const DATA = "https://data-api.polymarket.com";
const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const LOOKBACK_DAYS = Number(process.env.WALLET_LOOKBACK_DAYS ?? "90");
const TRADE_LIMIT = Number(process.env.WALLET_TRADE_LIMIT ?? "10000");

const WALLETS = [
  ["HighTempTation", "0x6011655c4afb76f36dd1b08a137a1ba73466b31e"],
  ["Weatherstappen", "0xb9012e0d9b60d3920286309328b935cdfa609fc4"],
  ["BeefSlayer", "0x331bf91c132af9d921e1908ca0979363fc47193f"],
  ["JoeTheMeteorologist", "0x1838cca016850ac7185a9b149fe7d0bd2d6629b4"],
  ["ColdMath", "0x594edb9112f526fa6a80b8f858a6379c8a2c1c11"],
  ["gopfan2", "0xf2f6af4f27ec2dcf4072095ab804016e14cd5817"],
  ["Maskache2", "0x1f66796b45581868376365aef54b51eb84184c8d"],
  ["badatmath", "0x8fbd7cf5f806f563080864694415829f7229a959"],
];

const US_CITIES = {
  "los angeles": { station: "LAX", icao: "KLAX", network: "CA_ASOS", tz: "America/Los_Angeles" },
  "san francisco": { station: "SFO", icao: "KSFO", network: "CA_ASOS", tz: "America/Los_Angeles" },
  miami: { station: "MIA", icao: "KMIA", network: "FL_ASOS", tz: "America/New_York" },
  "new york city": { station: "LGA", icao: "KLGA", network: "NY_ASOS", tz: "America/New_York" },
  chicago: { station: "ORD", icao: "KORD", network: "IL_ASOS", tz: "America/Chicago" },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchRetry(url, { text = false, attempts = 5 } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "source-to-sim-wallet-research/1.0" } });
      if (response.ok) return text ? response.text() : response.json();
      const body = await response.text();
      last = new Error(`${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw last;
    } catch (error) {
      last = error;
    }
    await sleep(Math.min(5000, 400 * 2 ** i));
  }
  throw last;
}

function pct(n, d) { return d ? `${(100 * n / d).toFixed(1)}%` : "n/a"; }
function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function avg(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function money(x) { return x == null ? "n/a" : `$${x.toFixed(2)}`; }
function price(x) { return x == null ? "n/a" : `${(x * 100).toFixed(1)}c`; }

function weatherTrade(t) {
  return /highest temperature|lowest temperature|will it rain|precipitation|snow/i.test(t.title ?? "");
}
function highTempTrade(t) { return /highest temperature/i.test(t.title ?? ""); }

function parseCity(title) {
  const m = String(title ?? "").match(/highest temperature in (.+?) (?:be|on )/i);
  if (!m) return null;
  let city = m[1].trim().replace(/,?\s+(CA|FL|NY|IL)$/i, "");
  return city.toLowerCase();
}

function parseEventDate(title) {
  const m = String(title ?? "").match(/on\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!m) return null;
  const months = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
  const now = new Date();
  let year = m[3] ? Number(m[3]) : now.getUTCFullYear();
  const month = months[m[1].toLowerCase()];
  let d = new Date(Date.UTC(year, month, Number(m[2])));
  // If title omitted year and appears implausibly far in future, use prior year.
  if (!m[3] && d.getTime() > now.getTime() + 120 * 86400_000) d = new Date(Date.UTC(year - 1, month, Number(m[2])));
  return d.toISOString().slice(0, 10);
}

function parseBucketF(title) {
  const s = String(title ?? "").replace(/°/g, "");
  let m = s.match(/between\s+(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)\s*F/i);
  if (m) return { kind: "range", low: Number(m[1]), high: Number(m[2]) };
  m = s.match(/(?:be\s+)?(-?\d+(?:\.\d+)?)\s*F\s+or\s+(?:higher|above)/i);
  if (m) return { kind: "at_or_above", value: Number(m[1]) };
  m = s.match(/(?:be\s+)?(-?\d+(?:\.\d+)?)\s*F\s+or\s+(?:below|lower)/i);
  if (m) return { kind: "at_or_below", value: Number(m[1]) };
  return null;
}

function localParts(ts, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false,
  }).formatToParts(new Date(ts * 1000));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

function isoParts(date) {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}
function addDays(date, days) {
  const p = isoParts(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + days)).toISOString().slice(0, 10);
}
function csvRows(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((h, i) => [h.trim(), (line.split(",")[i] ?? "").trim()])));
}

async function fetchObservations(config, startDate, endDate) {
  const s = isoParts(startDate), e = isoParts(addDays(endDate, 1));
  const p = new URLSearchParams({
    station: config.station, network: config.network, data: "tmpf",
    year1:String(s.year), month1:String(s.month), day1:String(s.day),
    year2:String(e.year), month2:String(e.month), day2:String(e.day),
    tz:"Etc/UTC", format:"onlycomma", latlon:"no", elev:"no", missing:"M", trace:"T", direct:"no",
  });
  p.append("report_type", "1"); p.append("report_type", "3"); p.append("report_type", "4");
  const text = await fetchRetry(`${IEM}?${p}`, { text: true });
  const byDate = new Map();
  for (const row of csvRows(text)) {
    if (!row.valid || !row.tmpf || row.tmpf === "M") continue;
    const tempF = Number(row.tmpf); if (!Number.isFinite(tempF)) continue;
    const ms = Date.parse(`${row.valid.replace(" ", "T")}Z`); if (!Number.isFinite(ms)) continue;
    const lp = localParts(Math.floor(ms / 1000), config.tz);
    if (lp.date < startDate || lp.date > endDate) continue;
    const arr = byDate.get(lp.date) ?? [];
    arr.push({ ts: Math.floor(ms / 1000), tempF }); byDate.set(lp.date, arr);
  }
  for (const arr of byDate.values()) arr.sort((a, b) => a.ts - b.ts);
  return byDate;
}

function observationState(observations, tradeTs, bucket) {
  let max = -Infinity, maxSetTs = null, count = 0;
  for (const o of observations ?? []) {
    if (o.ts > tradeTs) break;
    count += 1;
    if (o.tempF > max) { max = o.tempF; maxSetTs = o.ts; }
  }
  if (!count || !Number.isFinite(max)) return null;
  let state;
  if (bucket.kind === "range") {
    state = max > bucket.high ? "DEAD_HIGH" : max >= bucket.low ? "INSIDE_BUCKET" : "BELOW_BUCKET";
  } else if (bucket.kind === "at_or_above") {
    state = max >= bucket.value ? "THRESHOLD_ALREADY_REACHED" : "BELOW_THRESHOLD";
  } else {
    state = max > bucket.value ? "DEAD_HIGH" : "STILL_ALIVE";
  }
  return { state, observedMaxF: max, minutesSinceMax: maxSetTs == null ? null : (tradeTs - maxSetTs) / 60 };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item); const arr = map.get(k) ?? []; arr.push(item); map.set(k, arr);
  }
  return map;
}

async function fetchWalletTrades(address) {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const params = new URLSearchParams({ user: address, limit: String(TRADE_LIMIT), offset: "0", start: String(since) });
  const rows = await fetchRetry(`${DATA}/trades?${params}`);
  return Array.isArray(rows) ? rows : [];
}

function summarizeWallet(name, trades, obsCache) {
  const weather = trades.filter(weatherTrade);
  const buys = weather.filter((t) => t.side === "BUY");
  const sells = weather.filter((t) => t.side === "SELL");
  const marketGroups = groupBy(weather, (t) => t.conditionId);
  const buyGroups = groupBy(buys, (t) => t.conditionId);
  const firstBuys = [...buyGroups.values()].map((rows) => rows.reduce((a, b) => Number(a.timestamp) <= Number(b.timestamp) ? a : b));
  const firstPrices = firstBuys.map((t) => Number(t.price)).filter(Number.isFinite);
  const allBuyPrices = buys.map((t) => Number(t.price)).filter(Number.isFinite);
  const low = allBuyPrices.filter((p) => p < .20).length;
  const mid = allBuyPrices.filter((p) => p >= .20 && p <= .55).length;
  const high = allBuyPrices.filter((p) => p > .55).length;
  const yes = buys.filter((t) => String(t.outcome).toUpperCase() === "YES").length;
  const no = buys.filter((t) => String(t.outcome).toUpperCase() === "NO").length;
  const dcaCounts = [...buyGroups.values()].map((r) => r.length);

  const timing = [];
  const stationStates = [];
  for (const t of firstBuys.filter(highTempTrade)) {
    const city = parseCity(t.title); const config = city ? US_CITIES[city] : null;
    const date = parseEventDate(t.title); if (!config || !date) continue;
    const lp = localParts(Number(t.timestamp), config.tz);
    const offsetDays = Math.round((Date.parse(`${lp.date}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400_000);
    timing.push({ city, hour: lp.hour + lp.minute / 60, offsetDays, price: Number(t.price), title: t.title, ts: Number(t.timestamp), date });
    if (offsetDays === 0) {
      const bucket = parseBucketF(t.title);
      const obs = obsCache.get(city)?.get(date);
      if (bucket && obs) {
        const state = observationState(obs, Number(t.timestamp), bucket);
        if (state) stationStates.push({ ...state, city, price: Number(t.price), hour: lp.hour + lp.minute / 60, title: t.title });
      }
    }
  }

  const sameDay = timing.filter((x) => x.offsetDays === 0);
  const priorDay = timing.filter((x) => x.offsetDays < 0);
  const postDate = timing.filter((x) => x.offsetDays > 0);
  const after15 = sameDay.filter((x) => x.hour >= 15).length;
  const after17 = sameDay.filter((x) => x.hour >= 17).length;
  const stateCounts = Object.fromEntries([...groupBy(stationStates, (x) => x.state)].map(([k, v]) => [k, v.length]));

  return {
    name,
    tradesRetrieved: trades.length,
    weatherTrades: weather.length,
    weatherMarkets: marketGroups.size,
    buys: buys.length, sells: sells.length,
    buySellRatio: buys.length ? sells.length / buys.length : null,
    medianBuyPrice: median(allBuyPrices),
    medianFirstBuyPrice: median(firstPrices),
    meanFirstBuyPrice: avg(firstPrices),
    priceBins: { low, mid, high },
    yes, no,
    medianDcaBuys: median(dcaCounts),
    meanDcaBuys: avg(dcaCounts),
    firstBuySameDay: sameDay.length,
    firstBuyPriorDay: priorDay.length,
    firstBuyPostDate: postDate.length,
    sameDayAfter15: after15,
    sameDayAfter17: after17,
    medianSameDayHour: median(sameDay.map((x) => x.hour)),
    stationStates: stateCounts,
    stationStateRows: stationStates,
  };
}

async function main() {
  const allTrades = new Map();
  let minDate = new Date().toISOString().slice(0, 10), maxDate = "1970-01-01";
  for (const [name, address] of WALLETS) {
    process.stdout.write(`Fetching ${name} ... `);
    const trades = await fetchWalletTrades(address);
    allTrades.set(name, trades);
    for (const t of trades.filter(highTempTrade)) {
      const d = parseEventDate(t.title); if (d) { if (d < minDate) minDate = d; if (d > maxDate) maxDate = d; }
    }
    console.log(`${trades.length} trades`);
    await sleep(150);
  }

  // Bound public observation requests to the configured lookback window.
  const floor = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
  if (minDate < floor) minDate = floor;
  const today = new Date().toISOString().slice(0, 10);
  if (maxDate > today) maxDate = today;

  const obsCache = new Map();
  if (minDate <= maxDate) {
    for (const [city, config] of Object.entries(US_CITIES)) {
      process.stdout.write(`Observations ${city} ${minDate}..${maxDate} ... `);
      try {
        const obs = await fetchObservations(config, minDate, maxDate);
        obsCache.set(city, obs); console.log(`${obs.size} days`);
      } catch (error) {
        console.log(`FAILED ${error.message}`); obsCache.set(city, new Map());
      }
      await sleep(150);
    }
  }

  const summaries = [...allTrades.entries()].map(([name, trades]) => summarizeWallet(name, trades, obsCache));

  const lines = [
    "# Public Weather Wallet Reverse Engineering",
    "",
    `Lookback: last ${LOOKBACK_DAYS} days; up to ${TRADE_LIMIT} public trades/wallet.`,
    "",
    "Research-only. Public Polymarket Data API + public IEM station observations. Observation-state features are clues, not settlement-equivalence claims.",
    "",
    "## Cross-wallet behavior",
    "",
    "| Wallet | Weather mkts | BUY/SELL | Median first BUY | Low <20c | High >55c | Avg BUYs/mkt | Same-day US first buys | >=3pm local | >=5pm local |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];

  for (const s of summaries) {
    lines.push(`| ${s.name} | ${s.weatherMarkets} | ${s.buys}/${s.sells} | ${price(s.medianFirstBuyPrice)} | ${pct(s.priceBins.low, s.buys)} | ${pct(s.priceBins.high, s.buys)} | ${s.meanDcaBuys?.toFixed(1) ?? "n/a"} | ${s.firstBuySameDay} | ${pct(s.sameDayAfter15, s.firstBuySameDay)} | ${pct(s.sameDayAfter17, s.firstBuySameDay)} |`);
  }

  lines.push("", "## Exact-station observation-state clues (first same-day BUY only)", "");
  for (const s of summaries) {
    const total = s.stationStateRows.length;
    lines.push(`### ${s.name}`);
    lines.push(`Rows with usable U.S. station evidence: **${total}**. Same-day median first-BUY local hour: **${s.medianSameDayHour == null ? "n/a" : s.medianSameDayHour.toFixed(2)}**.`);
    if (!total) { lines.push("No usable rows in the bounded sample.", ""); continue; }
    const ordered = ["DEAD_HIGH", "THRESHOLD_ALREADY_REACHED", "INSIDE_BUCKET", "BELOW_BUCKET", "BELOW_THRESHOLD", "STILL_ALIVE"];
    lines.push(ordered.filter((k) => s.stationStates[k]).map((k) => `${k}=${s.stationStates[k]} (${pct(s.stationStates[k], total)})`).join("; "));
    const examples = s.stationStateRows.slice(0, 8);
    lines.push("", "Representative rows:", "");
    for (const e of examples) lines.push(`- ${e.city}, ${e.hour.toFixed(2)} local, entry ${price(e.price)}, observed max ${e.observedMaxF.toFixed(1)}F, state ${e.state}: ${e.title}`);
    lines.push("");
  }

  lines.push(
    "## Interpretation rules",
    "",
    "- High-price + late + threshold-already-reached behavior suggests information/timing capture rather than forecast-first value betting.",
    "- Low-price + early behavior suggests distribution/tail-value betting; profitability must come from payoff asymmetry, not raw win rate.",
    "- Heavy selling indicates active inventory/position management; copying only buys would not reproduce the strategy.",
    "- Any strategy inferred here must be re-tested on U.S.-venue rules/prices with frozen out-of-sample data before paper activation.",
    "- No wallet behavior here authorizes bypassing geographic restrictions or copying international contracts onto non-equivalent U.S. contracts.",
  );

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-wallet-reverse-engineering.md", `${lines.join("\n")}\n`);
  await writeFile("research-output/weather-wallet-reverse-engineering.json", JSON.stringify(summaries, null, 2));
  console.log(`\n${lines.join("\n")}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
