#!/usr/bin/env node

/**
 * Short-horizon repricing test.
 *
 * Tests a NARROWER and DIFFERENT hypothesis than the direct-copy preflight:
 * not "does holding the same bucket to U.S. settlement make money" (already
 * REJECTED), but "does BeefSlayer's trade predict the U.S. market's price
 * moving in the SAME direction over the next few minutes to an hour, such
 * that a fast follower could enter and exit for a scalp." This is motivated
 * by reverse-engineering BeefSlayer's actual on-chain lifecycle: it typically
 * buys and sells the SAME position 15-45 minutes later on the source venue,
 * which looks like it is trading intraday repricing rather than holding to
 * settlement.
 *
 * DESIGN CHOICES, stated explicitly because the task brief left them
 * implicit and they are load-bearing:
 *
 * - "Detection delay" D in {0,1,5,15} minutes is WHEN we, as a slower
 *   follower watching the wallet's on-chain activity, could first plausibly
 *   act. Entry happens at signal_ts + D. D=0 is an idealised reference point,
 *   not a realistic claim.
 * - "Horizon" H in {1,5,15,30,45,60} minutes is HOW LONG we hold AFTER
 *   entering, not minutes-since-signal. So (D=5, H=15) means: enter at
 *   signal+5m, exit at signal+20m. This matches "5-minute follower delay...
 *   realistic exit" as a delay-then-hold pair, and keeps every exit strictly
 *   after its own entry for every (D,H) combination.
 * - Entry lifts the ASK (yes_ask.close), stressed by the adverse-c shift.
 *   Exit hits the BID (yes_bid.close) as observed, with NO additional
 *   adverse shift -- the brief separates "test realistic entries: BASE/+1c/
 *   +2c/+3c" (an entry-side stress dimension) from "for exits use
 *   historically defensible executable-price proxies, not midpoint fantasy"
 *   (use the real bid, not a synthetic mid) as two different instructions,
 *   not one compounded stress.
 * - Fees are charged on BOTH legs (Kalshi's taker fee applies to closing a
 *   position early, not only to entering one).
 * - LANE A (exact bucket): reuses the direct-copy preflight's bucket-key
 *   equality. LANE B (event-level translation) does NOT require bucket
 *   equality. It picks, from that day's own Kalshi bucket ladder, whichever
 *   bucket's OWN ask price at signal time is closest to BeefSlayer's own
 *   entry price (treated as an implied probability on a $1-payout binary).
 *   This uses only information available at or before the signal instant,
 *   so it never looks ahead, and is a materially different construction
 *   from "same numeric range" -- it is testing "if BeefSlayer thinks this is
 *   roughly an 8% event, does whichever Kalshi bucket ALSO currently prices
 *   near 8% start moving."
 * - CONTROL: for each trigger (city, local-hour-of-day, entry price band),
 *   sample deterministic non-trigger dates for the same city (excluding
 *   every date that city's wallet actually traded, to avoid leaking signal
 *   into the control pool) and pick whichever bucket in that day's ladder
 *   was priced in the SAME band at the SAME local hour, then measure the
 *   identical price-move-over-horizon metric. Kalshi's daily events close at
 *   a similar wall-clock time every night, so hour-of-day matching also
 *   approximately preserves distance-from-settlement; this is a
 *   simplification and is stated here rather than silently assumed.
 * - Segmentation cells are predefined below and never touched after seeing
 *   results.
 *
 * Public data only. No credentials, orders, Lovable, or production.
 */
import { mkdir, writeFile } from "node:fs/promises";

const DATA = "https://data-api.polymarket.com", K = "https://external-api.kalshi.com/trade-api/v2";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? "120");
const CONTRACTS = Number(process.env.CONTRACTS ?? "100");
const QUOTE_MAX_LAG_SECONDS = Number(process.env.QUOTE_MAX_LAG_SECONDS ?? "300");
const CONTROLS_PER_TRIGGER = Number(process.env.CONTROLS_PER_TRIGGER ?? "2");
const WALLET = ["BeefSlayer", "0x331bf91c132af9d921e1908ca0979363fc47193f"];

const CITIES = [
  { key: "NYC", names: ["new york city", "new york", "nyc"], series: "KXHIGHNY" },
  { key: "CHI", names: ["chicago"], series: "KXHIGHCHI" },
  { key: "LAX", names: ["los angeles"], series: "KXHIGHLAX" },
  { key: "SFO", names: ["san francisco"], series: "KXHIGHTSFO" },
  { key: "MIA", names: ["miami"], series: "KXHIGHMIA" },
];
const TIMEZONE_BY_CITY = { NYC: "America/New_York", CHI: "America/Chicago", LAX: "America/Los_Angeles", SFO: "America/Los_Angeles", MIA: "America/New_York" };

const MONTH = new Map([["jan",1],["january",1],["feb",2],["february",2],["mar",3],["march",3],["apr",4],["april",4],["may",5],["jun",6],["june",6],["jul",7],["july",7],["aug",8],["august",8],["sep",9],["sept",9],["september",9],["oct",10],["october",10],["nov",11],["november",11],["dec",12],["december",12]]);
const MONTH3 = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Detection delay: WHEN we enter, relative to the signal instant.
const DELAYS_SEC = [0, 60, 300, 900];
// Hold duration: HOW LONG after entry we exit. Exit time = entry time + hold.
const HOLDS_SEC = [60, 300, 900, 1800, 2700, 3600];
const ADVERSE = [0, 0.01, 0.02, 0.03];

/**
 * A non-retryable status (e.g. 404 for a ticker that does not exist) must
 * throw immediately, not be retried. The throw for that case is deliberately
 * OUTSIDE the try/catch below -- putting it inside would let this same
 * function's own catch swallow it and retry anyway, burning the full
 * exponential backoff (up to ~25s) on every 404. That bug was real, present,
 * and confirmed to cause multi-minute stalls per trigger before this fix.
 */
async function fetchJson(url, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": "source-to-sim-hybrid-repricing/1.0" } });
    } catch (e) {
      last = e;
      await sleep(Math.min(10000, 500 * 2 ** i));
      continue;
    }
    if (res.ok) return res.json();
    const body = await res.text();
    last = new Error(`${res.status} ${res.statusText}: ${body.slice(0, 180)}`);
    if (![429, 500, 502, 503, 504].includes(res.status)) throw last;
    await sleep(Math.min(10000, 500 * 2 ** i));
  }
  throw last;
}

const rowKey = r => [r.transactionHash, r.asset, r.type, r.timestamp, r.side, r.size, r.usdcSize].join("|");
async function activity(address, sinceTs) {
  const seen = new Set(), out = [];
  let end = null;
  for (;;) {
    let fresh = 0;
    for (let offset = 0; offset < 5000; offset += 500) {
      const p = new URLSearchParams({ user: address, limit: "500", offset: String(offset), sortBy: "TIMESTAMP", sortDirection: "DESC" });
      if (end != null) p.set("end", String(end));
      const rows = await fetchJson(`${DATA}/activity?${p}`);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) { const k = rowKey(r); if (!seen.has(k)) { seen.add(k); out.push(r); fresh++; } }
      if (rows.length < 500) break;
      await sleep(35);
    }
    if (!out.length) break;
    const oldest = Math.min(...out.map(r => Number(r.timestamp)).filter(Number.isFinite));
    if (!Number.isFinite(oldest) || oldest < sinceTs || fresh === 0) break;
    end = oldest;
  }
  return out.filter(r => Number(r.timestamp) >= sinceTs);
}

function cityOf(text) { const s = String(text ?? "").toLowerCase().replace(/[-_]/g, " "); for (const c of CITIES) if (c.names.some(n => s.includes(n))) return c; return null; }
function iso(y, m, d) { const x = new Date(Date.UTC(y, m - 1, d)); if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== d) return null; return `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`; }
function sourceDate(r) {
  const raw = `${r.eventSlug ?? ""} ${r.slug ?? ""} ${r.title ?? ""}`.toLowerCase().replace(/[-_/]/g, " ");
  let m = raw.match(/\b(20\d{2})\s+(\d{1,2})\s+(\d{1,2})\b/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = raw.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:\s+(20\d{2}))?\b/);
  if (m) { const mm = MONTH.get(m[1]), yy = m[3] ? Number(m[3]) : new Date(Number(r.timestamp) * 1000).getUTCFullYear(); const v = iso(yy, mm, Number(m[2])); if (v) return v; }
  const raw2 = `${r.eventSlug ?? ""} ${r.slug ?? ""} ${r.title ?? ""}`;
  m = raw2.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  return m ? iso(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
function parseBucket(text) {
  const raw = String(text ?? "").toLowerCase().replace(/[–—]/g, "-").replace(/degrees?/g, "°").replace(/fahrenheit/g, "f").replace(/\s+/g, " ");
  let m = raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:to|-)\s*(-?\d+(?:\.\d+)?)\s*(?:°\s*f?|f)\b/i);
  if (m) return { kind: "range", low: Number(m[1]), high: Number(m[2]), key: `range:${Number(m[1])}:${Number(m[2])}` };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:or\s+below|or\s+lower|or\s+less|and\s+below|or\s+under|or\s+fewer)/i);
  if (m) return { kind: "below", value: Number(m[1]), key: `below:${Number(m[1])}` };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:or\s+above|or\s+higher|or\s+more|and\s+above|or\s+over)/i);
  if (m) return { kind: "above", value: Number(m[1]), key: `above:${Number(m[1])}` };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:°\s*f?|f)\b/i);
  if (m) return { kind: "exact", value: Number(m[1]), key: `exact:${Number(m[1])}` };
  return null;
}
function sourceBucket(r) { return parseBucket(r.outcome) ?? parseBucket(r.title) ?? parseBucket(r.slug); }
function eventDate(t) { const m = String(t ?? "").match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})$/i); return m ? `20${m[1]}-${MONTH3[m[2].toUpperCase()]}-${m[3]}` : null; }
function targetBucket(m) {
  const fromText = parseBucket(`${m.yes_sub_title ?? ""} ${m.subtitle ?? ""}`);
  if (fromText) return fromText;
  const b = String(m.ticker ?? "").match(/-B(-?\d+(?:\.\d+)?)$/i);
  if (b) { const mid = Number(b[1]), low = mid - .5, high = mid + .5; return { kind: "range", low, high, key: `range:${low}:${high}` }; }
  return parseBucket(m.title);
}
function closeTs(m) { for (const k of ["close_time", "expiration_time", "expected_expiration_time", "latest_expiration_time"]) { const t = Date.parse(m?.[k] ?? ""); if (Number.isFinite(t)) return Math.floor(t / 1000); } return null; }
async function historicalMarkets(series) { const out = []; let cursor = null; do { const p = new URLSearchParams({ series_ticker: series, limit: "1000" }); if (cursor) p.set("cursor", cursor); const d = await fetchJson(`${K}/historical/markets?${p}`); out.push(...(d.markets ?? [])); cursor = d.cursor || null; if (cursor) await sleep(40); } while (cursor); return out; }
async function currentSettledMarkets(series) { const out = []; let cursor = null; do { const p = new URLSearchParams({ series_ticker: series, status: "settled", limit: "1000" }); if (cursor) p.set("cursor", cursor); const d = await fetchJson(`${K}/markets?${p}`); out.push(...(d.markets ?? [])); cursor = d.cursor || null; if (cursor) await sleep(40); } while (cursor); return out; }
async function eventCatalog(series, startDate, endDate) {
  const both = [...await historicalMarkets(series), ...await currentSettledMarkets(series)];
  const byTicker = new Map(both.map(m => [m.ticker, m]));
  const byDate = new Map();
  for (const m of byTicker.values()) {
    const date = eventDate(m.event_ticker);
    if (!date || date < startDate || date > endDate) continue;
    const b = targetBucket(m);
    if (!b) continue;
    const a = byDate.get(date) ?? [];
    a.push({ ...m, _date: date, _bucket: b });
    byDate.set(date, a);
  }
  return byDate;
}

function priceCloses(c) {
  const ask = [c?.yes_ask?.close, c?.yes_ask?.close_dollars, c?.yes_ask?.close_price].map(Number).find(Number.isFinite) ?? null;
  const bid = [c?.yes_bid?.close, c?.yes_bid?.close_dollars, c?.yes_bid?.close_price].map(Number).find(Number.isFinite) ?? null;
  return { ask, bid };
}
/**
 * BUG FOUND WHILE SMOKE-TESTING: Kalshi's /historical/markets/{ticker}/
 * candlesticks route silently returns zero candles for many real, heavily
 * traded tickers (confirmed on KXHIGHNY-26AUG01-B84.5, $47k volume, HTTP 200,
 * empty array) -- while /series/{series}/markets/{ticker}/candlesticks
 * returns real data for the SAME ticker/window. The already-committed direct-
 * copy script already tries both URLs for exactly this reason; this function
 * had dropped that fallback when first written and is fixed here to match.
 * Confirmed this was the cause of a 100% NO_TRADABLE_BUCKET_AT_SIGNAL rate in
 * a 20-day smoke test before this fix.
 */
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
function localHour(ts, tz) { return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(ts * 1000))); }
function priceBand(p) { if (p < .05) return "<5c"; if (p < .10) return "5-10c"; if (p < .20) return "10-20c"; if (p <= .55) return "20-55c"; if (p < .90) return "55-90c"; return ">=90c"; }
function sizeBand(usdc) { if (usdc < 25) return "<$25"; if (usdc < 100) return "$25-100"; return ">=$100"; }
function hourBand(h) { if (h < 10) return "morning(<10)"; if (h < 14) return "midday(10-14)"; if (h < 18) return "afternoon(14-18)"; return "evening(>=18)"; }

/** Deterministic PRNG so control sampling is reproducible without external state. */
function lcg(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/**
 * One priced repricing sample: entry(delay) x exit(delay+hold) x adverse, for
 * every combination. Returns null cells (not zero) where data was missing.
 */
function priceCandidate(candles, signalTs) {
  const cells = [];
  for (const delay of DELAYS_SEC) {
    const entryQ = nearestAt(candles, signalTs + delay, "ask");
    if (!entryQ) { for (const hold of HOLDS_SEC) for (const adv of ADVERSE) cells.push({ delay, hold, adv, status: "NO_ENTRY_QUOTE" }); continue; }
    for (const hold of HOLDS_SEC) {
      const exitQ = nearestAt(candles, signalTs + delay + hold, "bid");
      if (!exitQ) { for (const adv of ADVERSE) cells.push({ delay, hold, adv, status: "NO_EXIT_QUOTE" }); continue; }
      for (const adv of ADVERSE) {
        const entryPrice = Math.min(0.99, entryQ.value + adv);
        const exitPrice = exitQ.value;
        const feeIn = fee(CONTRACTS, entryPrice), feeOut = fee(CONTRACTS, exitPrice);
        const grossMove = exitPrice - entryPrice;
        const netPnl = grossMove * CONTRACTS - feeIn - feeOut;
        const capital = entryPrice * CONTRACTS + feeIn;
        cells.push({
          delay, hold, adv, status: "OK",
          entryPrice, exitPrice, grossMove, feeIn, feeOut, netPnl,
          roi: capital ? netPnl / capital : null, capital,
          entryLagSeconds: entryQ.lagSeconds, exitLagSeconds: exitQ.lagSeconds,
        });
      }
    }
  }
  return cells;
}

function cellKey(delay, hold, adv) { return `${delay}|${hold}|${adv}`; }

/** Roll a set of priced candidates up to station-day (independent unit), per cell. */
function aggregateByCell(rows) {
  const byCell = new Map();
  for (const r of rows) {
    for (const c of r.cells) {
      if (c.status !== "OK") continue;
      const ck = cellKey(c.delay, c.hold, c.adv);
      const dayKey = `${r.city}|${r.date}`;
      const m = byCell.get(ck) ?? new Map();
      const g = m.get(dayKey) ?? { pnl: 0, capital: 0, n: 0, date: r.date, grossMoves: [] };
      g.pnl += c.netPnl; g.capital += c.capital; g.n++; g.grossMoves.push(c.grossMove);
      m.set(dayKey, g);
      byCell.set(ck, m);
    }
  }
  return byCell;
}
function lcgBoot(seed) { return lcg(seed); }
function metricsFromDays(days) {
  if (!days.length) return null;
  const pnl = days.reduce((a, d) => a + d.pnl, 0), capital = days.reduce((a, d) => a + d.capital, 0);
  const wins = days.filter(d => d.pnl > 0), losses = days.filter(d => d.pnl < 0);
  const gw = wins.reduce((a, d) => a + d.pnl, 0), gl = -losses.reduce((a, d) => a + d.pnl, 0);
  let eq = 0, peak = 0, maxDD = 0;
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of sorted) { eq += d.pnl; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); }
  const allMoves = days.flatMap(d => d.grossMoves);
  const meanMove = allMoves.length ? allMoves.reduce((a, b) => a + b, 0) / allMoves.length : null;
  const sortedMoves = [...allMoves].sort((a, b) => a - b);
  const medianMove = sortedMoves.length ? sortedMoves[Math.floor(sortedMoves.length / 2)] : null;
  const favorable = allMoves.length ? allMoves.filter(m => m > 0).length / allMoves.length : null;
  return {
    n: days.length, pnl, capital, roi: capital ? pnl / capital : null,
    pf: gl ? gw / gl : null, winRate: days.length ? wins.length / days.length : null,
    maxDrawdown: maxDD, meanMove, medianMove, favorableShare: favorable,
  };
}
function bootstrapCI(days, iters = 2000) {
  if (!days.length) return null;
  const r = lcgBoot(hashStr(days.map(d => d.date).join(",")) || 1);
  const totals = [];
  for (let b = 0; b < iters; b++) { let t = 0; for (let i = 0; i < days.length; i++) t += days[Math.floor(r() * days.length)].pnl; totals.push(t); }
  totals.sort((a, b) => a - b);
  return [totals[Math.floor(0.025 * iters)], totals[Math.floor(0.975 * iters)]];
}
function trimTopWinnerDays(days, frac) {
  const winners = days.filter(d => d.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  const dropN = Math.ceil(winners.length * frac);
  const drop = new Set(winners.slice(0, dropN).map(d => `${d.date}`));
  return days.filter(d => !drop.has(d.date));
}

const pct = x => x == null ? "n/a" : `${(100 * x).toFixed(1)}%`;
const money = x => x == null ? "n/a" : `$${x.toFixed(2)}`;
const fmtC = x => x == null ? "n/a" : `${(100 * x).toFixed(2)}c`;

async function main() {
  const [name, address] = WALLET;
  const endDate = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
  const sinceTs = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);

  console.log(`Building Kalshi event catalog ${startDate}..${endDate}`);
  const catalogs = new Map();
  for (const c of CITIES) {
    process.stdout.write(`${c.key} ... `);
    const cat = await eventCatalog(c.series, startDate, endDate);
    catalogs.set(c.key, cat);
    console.log(`${cat.size} dates`);
  }

  process.stdout.write(`Fetching ${name} activity ... `);
  const act = await activity(address, sinceTs);
  console.log(`${act.length} rows`);
  const weatherTrades = act.filter(r => r.type === "TRADE" && /highest temperature/i.test(r.title ?? ""));
  const buys = weatherTrades.filter(r => r.side === "BUY");

  const parsed = [];
  for (const r of buys) {
    const c = cityOf(`${r.title ?? ""} ${r.eventSlug ?? ""}`);
    if (!c) continue;
    const date = sourceDate(r);
    if (!date || date < startDate || date > endDate) continue;
    const b = sourceBucket(r);
    if (!b) continue;
    parsed.push({ raw: r, city: c.key, series: c.series, date, bucket: b, ts: Number(r.timestamp), sourcePrice: Number(r.price), sourceUsdc: Number(r.usdcSize), asset: r.asset });
  }
  parsed.sort((a, b) => a.ts - b.ts);

  // First-per-city/date/bucket signal (the trigger instant), plus DCA/multi-bucket/later-sell context.
  const first = [], seenBucket = new Set();
  const buysByCityDate = new Map(), buysByCityDateBucket = new Map();
  for (const p of parsed) {
    const cd = `${p.city}|${p.date}`, cdb = `${p.city}|${p.date}|${p.bucket.key}`;
    (buysByCityDate.get(cd) ?? buysByCityDate.set(cd, []).get(cd)).push(p);
    (buysByCityDateBucket.get(cdb) ?? buysByCityDateBucket.set(cdb, []).get(cdb)).push(p);
    if (!seenBucket.has(cdb)) { seenBucket.add(cdb); first.push(p); }
  }
  const sellsByAsset = new Map();
  for (const r of weatherTrades.filter(r => r.side === "SELL")) { (sellsByAsset.get(r.asset) ?? sellsByAsset.set(r.asset, []).get(r.asset)).push(Number(r.timestamp)); }

  console.log(`${name}: ${parsed.length} parsed U.S.-city BUYs, ${first.length} first-per-city/date/bucket signals`);

  const triggerDatesByCity = new Map();
  for (const p of first) { const s = triggerDatesByCity.get(p.city) ?? new Set(); s.add(p.date); triggerDatesByCity.set(p.city, s); }

  // ---- LANE A: exact bucket, LANE B: probability-matched event-level bucket ----
  const laneA = [], laneB = [];
  const rejections = { LANE_A: {}, LANE_B: {} };
  const bump = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };

  const stationDaySeen = new Set();
  for (let i = 0; i < first.length; i++) {
    const s = first[i];
    const dayKey = `${s.city}|${s.date}`;
    const dayEvents = catalogs.get(s.city)?.get(s.date) ?? [];
    if (!dayEvents.length) { bump(rejections.LANE_A, "NO_EVENT_FOR_DATE"); bump(rejections.LANE_B, "NO_EVENT_FOR_DATE"); continue; }

    const ct = closeTs(dayEvents[0]);
    if (ct != null && s.ts >= ct) { bump(rejections.LANE_A, "TARGET_ALREADY_CLOSED"); bump(rejections.LANE_B, "TARGET_ALREADY_CLOSED"); continue; }

    const buysAtBucket = buysByCityDateBucket.get(`${s.city}|${s.date}|${s.bucket.key}`) ?? [];
    const buysAtEvent = buysByCityDate.get(dayKey) ?? [];
    const bucketsThisEvent = new Set(buysAtEvent.map(p => p.bucket.key)).size;
    const sells = sellsByAsset.get(s.asset) ?? [];
    const context = {
      city: s.city, series: s.series, date: s.date, signalTs: s.ts, sourcePrice: s.sourcePrice, sourceUsdc: s.sourceUsdc,
      localHour: localHour(s.ts, TIMEZONE_BY_CITY[s.city]),
      priceBand: priceBand(s.sourcePrice), sizeBand: sizeBand(s.sourceUsdc),
      isDca: buysAtBucket.length > 1, bucketsThisEvent, multiBucket: bucketsThisEvent > 1,
      laterSold: sells.some(x => x > s.ts), bucketType: s.bucket.kind === "range" ? "range" : "tail",
    };

    // Lane A: exact key match.
    const exact = dayEvents.filter(m => m._bucket.key === s.bucket.key);
    if (exact.length === 1) {
      const cs = await candleWindow(s.series, exact[0].ticker, s.ts - 30, s.ts + 3660);
      if (cs.length) laneA.push({ ...context, ticker: exact[0].ticker, cells: priceCandidate(cs, s.ts) });
      else bump(rejections.LANE_A, "NO_CANDLES");
    } else bump(rejections.LANE_A, exact.length === 0 ? "TARGET_BUCKET_NOT_FOUND" : "TARGET_BUCKET_AMBIGUOUS");

    // Lane B: probability-matched bucket from the day's own ladder at signal time.
    let best = null;
    for (const m of dayEvents) {
      const cs = await candleWindow(s.series, m.ticker, s.ts - 30, s.ts + 3660);
      if (!cs.length) continue;
      const atSignal = nearestAt(cs, s.ts, "ask");
      if (!atSignal) continue;
      const dist = Math.abs(atSignal.value - s.sourcePrice);
      if (!best || dist < best.dist) best = { ticker: m.ticker, cs, dist, priceAtSignal: atSignal.value };
      await sleep(30);
    }
    if (best) laneB.push({ ...context, ticker: best.ticker, matchedAskAtSignal: best.priceAtSignal, matchDistance: best.dist, cells: priceCandidate(best.cs, s.ts) });
    else bump(rejections.LANE_B, "NO_TRADABLE_BUCKET_AT_SIGNAL");

    stationDaySeen.add(dayKey);
    if (i % 10 === 0) process.stdout.write(`\r  ${i + 1}/${first.length} triggers (A:${laneA.length} B:${laneB.length})   `);
    await sleep(30);
  }
  console.log(`\nLane A priced: ${laneA.length} signals / ${new Set(laneA.map(r => `${r.city}|${r.date}`)).size} station-days`);
  console.log(`Lane B priced: ${laneB.length} signals / ${new Set(laneB.map(r => `${r.city}|${r.date}`)).size} station-days`);

  // ---- CONTROL: matched non-trigger station-days, lane-B-style construction ----
  // Dedupe to one control search per station-day (not per bucket signal) --
  // a multi-bucket day should not multiply control-sampling work, since the
  // control comparison is already station-day independent downstream.
  const control = [];
  const laneBByDay = new Map();
  for (const r of laneB) { const k = `${r.city}|${r.date}`; if (!laneBByDay.has(k)) laneBByDay.set(k, r); }
  const uniqueDayTriggers = [...laneBByDay.values()];
  console.log(`Sampling control for ${uniqueDayTriggers.length} unique trigger station-days ...`);
  let controlProgress = 0;
  for (const trig of uniqueDayTriggers) {
    const rng = lcg(hashStr(`${trig.city}|${trig.date}|${trig.signalTs}`) || 1);
    const excludeDates = triggerDatesByCity.get(trig.city) ?? new Set();
    const allDates = [...(catalogs.get(trig.city)?.keys() ?? [])].filter(d => !excludeDates.has(d));
    if (!allDates.length) continue;
    let picked = 0, attempts = 0;
    while (picked < CONTROLS_PER_TRIGGER && attempts < CONTROLS_PER_TRIGGER * 6 && allDates.length) {
      attempts++;
      const date = allDates[Math.floor(rng() * allDates.length)];
      const events = catalogs.get(trig.city).get(date) ?? [];
      if (!events.length) continue;
      // Same local hour-of-day, on a different date.
      const ct = closeTs(events[0]);
      const cts = closeTsForLocalHour(date, trig.localHour, TIMEZONE_BY_CITY[trig.city]);
      if (ct != null && cts >= ct) continue;
      let best = null;
      for (const m of events) {
        const cs = await candleWindow(trig.series, m.ticker, cts - 30, cts + 3660);
        if (!cs.length) continue;
        const atT = nearestAt(cs, cts, "ask");
        if (!atT) continue;
        if (priceBand(atT.value) !== trig.priceBand) continue;
        const dist = Math.abs(atT.value - trig.sourcePrice);
        if (!best || (m._bucket.kind === "range") === (trig.bucketType === "range") && dist < best.dist) best = { ticker: m.ticker, cs, dist, priceAtSignal: atT.value };
        await sleep(25);
      }
      if (best) {
        control.push({
          city: trig.city, date, signalTs: cts, sourcePrice: trig.sourcePrice, priceBand: trig.priceBand,
          localHour: trig.localHour, ticker: best.ticker, cells: priceCandidate(best.cs, cts),
          matchedTriggerKey: `${trig.city}|${trig.date}|${trig.signalTs}`,
        });
        picked++;
      }
    }
    controlProgress++;
    if (controlProgress % 10 === 0) process.stdout.write(`\r  control ${controlProgress}/${uniqueDayTriggers.length}   `);
  }
  console.log(`\nControl priced: ${control.length} points / ${new Set(control.map(r => `${r.city}|${r.date}`)).size} station-days`);

  function closeTsForLocalHour(dateStr, hour, tz) {
    // Construct an instant on `dateStr` at approximately `hour` local time by
    // probing UTC offsets around midday and adjusting; simple and adequate
    // for hour-of-day matching (not sub-minute precision).
    for (let utcHour = 0; utcHour < 24; utcHour++) {
      const probe = new Date(`${dateStr}T${String(utcHour).padStart(2, "0")}:00:00Z`);
      if (localHour(Math.floor(probe.getTime() / 1000), tz) === hour) return Math.floor(probe.getTime() / 1000) + 1800;
    }
    return Math.floor(new Date(`${dateStr}T18:00:00Z`).getTime() / 1000);
  }

  // ---- Aggregation and reporting ----
  const KEY_CELL = { delay: 300, hold: null, adv: 0.01 }; // hold reported across full grid, per instructions.

  function reportForRows(rows, label) {
    const byCell = aggregateByCell(rows);
    const rowsMd = [];
    for (const delay of DELAYS_SEC) for (const hold of HOLDS_SEC) for (const adv of ADVERSE) {
      const ck = cellKey(delay, hold, adv);
      const days = [...(byCell.get(ck)?.values() ?? [])];
      const m = metricsFromDays(days);
      if (!m) continue;
      rowsMd.push({ delay, hold, adv, ...m, days });
    }
    return { byCell, rowsMd };
  }

  const laneAReport = reportForRows(laneA, "Lane A");
  const laneBReport = reportForRows(laneB, "Lane B");
  const controlReport = reportForRows(control, "Control");

  function keyTestRows(report) {
    return HOLDS_SEC.map(hold => {
      const r = report.rowsMd.find(x => x.delay === 300 && x.hold === hold && x.adv === 0.01);
      return r ?? { delay: 300, hold, adv: 0.01, n: 0, pnl: null, roi: null, pf: null };
    });
  }

  function segmentReport(rows, keyFn) {
    const groups = new Map();
    for (const r of rows) { const k = keyFn(r); (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
    const out = [];
    for (const [k, grp] of groups) {
      const cell = grp.map(r => ({ city: r.city, date: r.date, cells: r.cells.filter(c => c.delay === 300 && c.hold === 900 && c.adv === 0.01) }));
      const byCell = aggregateByCell(cell);
      const days = [...(byCell.get(cellKey(300, 900, 0.01))?.values() ?? [])];
      out.push({ group: k, ...(metricsFromDays(days) ?? { n: 0 }) });
    }
    return out.sort((a, b) => String(a.group).localeCompare(String(b.group)));
  }

  const rowMd = m => `| +${m.delay/60}m delay / +${m.hold/60}m hold / +${Math.round(m.adv*100)}c | ${m.n} | ${money(m.meanMove)} | ${money(m.medianMove)} | ${pct(m.favorableShare)} | ${money(m.pnl)} | ${pct(m.roi)} | ${m.pf==null?"n/a":m.pf.toFixed(2)+"x"} | ${money(m.maxDrawdown)} |`;

  let md = `# BeefSlayer Short-Horizon Repricing Test\n\n`;
  md += `Window **${startDate}..${endDate}** (${LOOKBACK_DAYS}d). Tests whether BeefSlayer's trade predicts short-horizon U.S. Kalshi price movement, not hold-to-settlement P/L (already REJECTED separately). Public data only; no orders.\n\n`;
  md += `Design: detection delay D = when a follower could act (signal+D); hold H = how long after entry before exit (exit = signal+D+H). Entry lifts the ask (+adverse); exit hits the real bid, no extra shift. Fees charged both legs.\n\n`;
  md += `Parsed U.S.-city BUYs: ${parsed.length}. First-per-city/date/bucket signals: ${first.length}.\n\n`;
  md += `Lane A (exact bucket) rejections: ${Object.entries(rejections.LANE_A).map(([k,v])=>`${k}=${v}`).join(", ") || "none"}.\n\n`;
  md += `Lane B (event-level, probability-matched) rejections: ${Object.entries(rejections.LANE_B).map(([k,v])=>`${k}=${v}`).join(", ") || "none"}.\n\n`;

  md += `## KEY TEST — +5m detection delay, +1c adverse entry, across every hold duration\n\n`;
  md += `### Lane A (exact bucket)\n\n| Cell | N (station-days) | Mean move | Median move | % favorable | P/L | ROI | PF | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${keyTestRows(laneAReport).map(rowMd).join("\n")}\n\n`;
  md += `### Lane B (event-level translation)\n\n| Cell | N (station-days) | Mean move | Median move | % favorable | P/L | ROI | PF | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${keyTestRows(laneBReport).map(rowMd).join("\n")}\n\n`;
  md += `### Control (matched non-trigger, Lane-B construction)\n\n| Cell | N (station-days) | Mean move | Median move | % favorable | P/L | ROI | PF | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${keyTestRows(controlReport).map(rowMd).join("\n")}\n\n`;

  md += `## Full grid (Lane B, every delay x hold at +1c adverse)\n\n| Cell | N | Mean move | Median move | % favorable | P/L | ROI | PF | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const delay of DELAYS_SEC) for (const hold of HOLDS_SEC) {
    const r = laneBReport.rowsMd.find(x => x.delay === delay && x.hold === hold && x.adv === 0.01);
    if (r) md += rowMd(r) + "\n";
  }

  md += `\n## Robustness (Lane B, +5m delay / +15m hold / +1c adverse — the key cell)\n\n`;
  const keyDays = [...(laneBReport.byCell.get(cellKey(300, 900, 0.01))?.values() ?? [])];
  const keyMetrics = metricsFromDays(keyDays);
  if (keyMetrics) {
    const ci = bootstrapCI(keyDays);
    const trim1 = metricsFromDays(trimTopWinnerDays(keyDays, 0.01));
    const trim5 = metricsFromDays(trimTopWinnerDays(keyDays, 0.05));
    md += `- N=${keyMetrics.n} station-days, P/L ${money(keyMetrics.pnl)}, ROI ${pct(keyMetrics.roi)}, PF ${keyMetrics.pf==null?"n/a":keyMetrics.pf.toFixed(2)+"x"}, win rate ${pct(keyMetrics.winRate)}, max DD ${money(keyMetrics.maxDrawdown)}.\n`;
    md += `- Bootstrap 95% CI on total P/L: ${ci ? `${money(ci[0])} .. ${money(ci[1])}` : "n/a"}.\n`;
    md += `- After removing top 1% winning days: ${money(trim1?.pnl)}. After top 5%: ${money(trim5?.pnl)}.\n`;
  } else {
    md += `- DATA_INSUFFICIENT: no station-days available in this cell.\n`;
  }

  md += `\n## Segmentation (Lane B, +5m delay / +15m hold / +1c adverse), predefined, not tuned post-hoc\n\n`;
  const segs = [
    ["Source price band", r => r.priceBand],
    ["City", r => r.city],
    ["Time of day", r => hourBand(r.localHour)],
    ["Source size band", r => r.sizeBand],
    ["First BUY vs DCA", r => r.isDca ? "DCA" : "FIRST_ONLY"],
    ["Buckets bought same event", r => r.multiBucket ? "MULTI_BUCKET" : "SINGLE_BUCKET"],
    ["Later sold on source", r => r.laterSold ? "LATER_SOLD" : "HELD"],
  ];
  for (const [label, keyFn] of segs) {
    const rows = segmentReport(laneB, keyFn).filter(g => g.n > 0);
    md += `### ${label}\n\n| Segment | N | P/L | ROI | PF | Win rate |\n|---|---:|---:|---:|---:|---:|\n`;
    for (const g of rows) md += `| ${g.group} | ${g.n} | ${money(g.pnl)} | ${pct(g.roi)} | ${g.pf==null?"n/a":g.pf.toFixed(2)+"x"} | ${pct(g.winRate)} |\n`;
    md += `\n`;
  }

  md += `## Control comparison\n\nDoes price movement after a BeefSlayer trade differ from ordinary movement at a matched city/hour/price-band? Compare the KEY TEST cell (+5m delay / +15m hold / +1c adverse) between Lane B and Control:\n\n`;
  const laneBKey = laneBReport.rowsMd.find(x => x.delay === 300 && x.hold === 900 && x.adv === 0.01);
  const ctrlKey = controlReport.rowsMd.find(x => x.delay === 300 && x.hold === 900 && x.adv === 0.01);
  md += `| | N | Mean move | % favorable | P/L | ROI | PF |\n|---|---:|---:|---:|---:|---:|---:|\n`;
  md += `| BeefSlayer trigger | ${laneBKey?.n ?? 0} | ${money(laneBKey?.meanMove)} | ${pct(laneBKey?.favorableShare)} | ${money(laneBKey?.pnl)} | ${pct(laneBKey?.roi)} | ${laneBKey?.pf==null?"n/a":laneBKey.pf.toFixed(2)+"x"} |\n`;
  md += `| Matched control | ${ctrlKey?.n ?? 0} | ${money(ctrlKey?.meanMove)} | ${pct(ctrlKey?.favorableShare)} | ${money(ctrlKey?.pnl)} | ${pct(ctrlKey?.roi)} | ${ctrlKey?.pf==null?"n/a":ctrlKey.pf.toFixed(2)+"x"} |\n\n`;

  md += `## B/C (Weather/NBM signal) status\n\nDATA_UNAVAILABLE for this run: not attempted here. A no-lookahead historical station-observation source (IEM ASOS archive, mesonet.agron.iastate.edu, official ASOS/METAR-derived, confirmed reachable with 2026 coverage for all five stations) was identified and verified in a companion investigation, but wiring an observation-threshold-crossing signal into this same run was out of scope for this bounded task. Do not substitute reanalysis for this lane if attempted later.\n\n`;

  md += `## Guardrails\n\n- Station-day is the independent unit for every P/L/PF/ROI figure; multiple buckets in the same city/date are summed into one day before aggregation.\n- A cell with a missing entry or exit quote is excluded (NO_ENTRY_QUOTE/NO_EXIT_QUOTE), never treated as a zero-move trade.\n- Segmentation cells were predefined before this run and are not tuned against the results.\n- This does not use \`/closed-positions.realizedPnl\`.\n- No credentials, orders, production changes, Lovable changes, or live trading.\n`;

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-hybrid-repricing.md", md);
  await writeFile("research-output/weather-hybrid-repricing.json", JSON.stringify({
    generatedAt: new Date().toISOString(), startDate, endDate, lookbackDays: LOOKBACK_DAYS, contracts: CONTRACTS,
    parsedBuys: parsed.length, firstSignals: first.length, laneASignals: laneA.length, laneBSignals: laneB.length, controlPoints: control.length,
    rejections, laneA, laneB, control,
  }, null, 2) + "\n");
  console.log(md);
}

main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
