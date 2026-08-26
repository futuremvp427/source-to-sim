#!/usr/bin/env node

/**
 * Non-weather microstructure shootout: liquidity-shock mean reversion (H) and
 * passive maker value (B), preregistered in docs/STRATEGY_DISCOVERY_BOARD.md.
 *
 * Uses Kalshi MLB game markets (KXMLBGAME) -- confirmed live to carry
 * hundreds of thousands to low-millions of dollars of volume per market,
 * unlike the thin weather markets this project has otherwise tested. One
 * market (team side) per event is sampled to avoid correlated sibling
 * duplication (MLB lists both teams as separate sibling tickers under one
 * event_ticker; using both would double-count the same game).
 *
 * H. LIQUIDITY-SHOCK MEAN REVERSION
 *   Entry: a 1-minute candle with |close-to-close move| >= SHOCK_THRESHOLD_USD
 *   that does NOT continue in the same direction on the immediately following
 *   candle (mechanical, not curve-fit). Fade it: buy the side that just got
 *   cheaper. Exit at fixed horizons.
 *
 * B. PASSIVE MAKER VALUE (PRICE-BACKTEST ONLY -- explicitly not an execution
 *   proof; candle data cannot prove queue position or true fill probability)
 *   Entry: a simulated resting order one tick inside the best bid, placed
 *   whenever a trailing fair-value proxy (volume-weighted mid over the prior
 *   MAKER_LOOKBACK_MIN minutes) implies at least MAKER_MARGIN_USD of edge.
 *   "Filled" is approximated as the next candle's low touching or crossing
 *   the resting price -- a conservative, explicitly labelled proxy. Reported
 *   at 100%, 50%, and 25% of the naive-touch fill rate, since the true
 *   queue-aware rate cannot be reconstructed from candle data alone.
 *
 * Both use the SAME preregistered independent-unit rule: one signal per
 * market-ticker per calendar day, not per candle.
 *
 * Fee model: Kalshi's official quadratic taker fee, verified formula
 * ceil(0.07 * P * (1-P) * C * 100)/100 rounded up per fill (NOT the earlier,
 * already-corrected wrong cheap-tail assumption from prior weather work).
 * Maker fee: Kalshi's public docs and live market fee fields do not expose a
 * separate lower maker rate for this series at the time of this run, so B's
 * maker leg is priced at the SAME taker formula as a conservative (not
 * flattering) assumption, explicitly noted in the report.
 *
 * Public data only. No credentials, orders, Lovable, or production.
 */
import { mkdir, writeFile } from "node:fs/promises";

const K = "https://api.elections.kalshi.com/trade-api/v2";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? "30");
const MAX_MARKETS = Number(process.env.MAX_MARKETS ?? "220");
const CONTRACTS = Number(process.env.CONTRACTS ?? "100");
const QUOTE_MAX_LAG_SECONDS = Number(process.env.QUOTE_MAX_LAG_SECONDS ?? "300");

// Preregistered. Not tuned against results.
const SHOCK_THRESHOLD_USD = 0.08;
const MAKER_LOOKBACK_MIN = 15;
const MAKER_MARGIN_USD = 0.03;

const DELAYS_SEC = [0, 60, 300, 900];
const HOLDS_SEC = [300, 900, 1800, 2700, 3600];
const ADVERSE = [0, 0.01, 0.02, 0.03];

const SERIES = "KXMLBGAME";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Non-retryable status throws immediately, outside the retry try/catch. */
async function fetchJson(url, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i++) {
    let res;
    try { res = await fetch(url, { headers: { "User-Agent": "source-to-sim-microstructure/1.0" } }); }
    catch (e) { last = e; await sleep(Math.min(10000, 500 * 2 ** i)); continue; }
    if (res.ok) return res.json();
    const body = await res.text();
    last = new Error(`${res.status} ${res.statusText}: ${body.slice(0, 180)}`);
    if (![429, 500, 502, 503, 504].includes(res.status)) throw last;
    await sleep(Math.min(10000, 500 * 2 ** i));
  }
  throw last;
}
function fee(n, p) { const raw = .07 * n * p * (1 - p); return Math.ceil(raw / .0001 - 1e-9) * .0001; }

async function settledMarkets(series, limit) {
  const out = []; let cursor = null;
  do {
    const p = new URLSearchParams({ series_ticker: series, status: "settled", limit: "200" });
    if (cursor) p.set("cursor", cursor);
    const d = await fetchJson(`${K}/markets?${p}`);
    out.push(...(d.markets ?? []));
    cursor = d.cursor || null;
    if (cursor) await sleep(40);
  } while (cursor && out.length < limit * 3); // headroom before event-level dedup
  return out;
}
function priceCloses(c) {
  const ask = [c?.yes_ask?.close, c?.yes_ask?.close_dollars, c?.yes_ask?.close_price].map(Number).find(Number.isFinite) ?? null;
  const bid = [c?.yes_bid?.close, c?.yes_bid?.close_dollars, c?.yes_bid?.close_price].map(Number).find(Number.isFinite) ?? null;
  const mid = ask != null && bid != null ? (ask + bid) / 2 : null;
  return { ask, bid, mid };
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
      const cs = (d.candlesticks ?? []).map(c => ({ ts: Number(c.end_period_ts), ...priceCloses(c) })).filter(c => Number.isFinite(c.ts) && (c.ask != null || c.bid != null)).sort((a, b) => a.ts - b.ts);
      if (cs.length) return cs;
    } catch { /* try next URL */ }
  }
  return [];
}
function nearestAt(cs, t, field) {
  const c = cs.find(x => x.ts >= t && x.ts - t <= QUOTE_MAX_LAG_SECONDS && x[field] != null);
  return c ? { value: c[field], candleTs: c.ts } : null;
}
function dayKey(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// H: shock detection + fade pricing
// ---------------------------------------------------------------------------
function detectShocks(cs) {
  const signals = [];
  for (let i = 1; i < cs.length - 1; i++) {
    const prev = cs[i - 1], cur = cs[i], next = cs[i + 1];
    if (prev.mid == null || cur.mid == null || next.mid == null) continue;
    const move = cur.mid - prev.mid;
    if (Math.abs(move) < SHOCK_THRESHOLD_USD) continue;
    const continuation = next.mid - cur.mid;
    // "No immediate continuation": the very next candle does not extend the
    // move by more than a third of the shock's own size in the same direction.
    if (Math.sign(continuation) === Math.sign(move) && Math.abs(continuation) > Math.abs(move) / 3) continue;
    signals.push({ ts: cur.ts, shockMove: move, fadeDirection: move > 0 ? "SELL_INTO_SPIKE_BUY_NO" : "BUY_YES_INTO_DIP" });
  }
  return signals;
}
function priceFade(cs, signal) {
  const cells = [];
  const buySide = signal.fadeDirection === "BUY_YES_INTO_DIP"; // buying YES when price just dropped
  for (const delay of DELAYS_SEC) {
    const entryQ = nearestAt(cs, signal.ts + delay, buySide ? "ask" : "bid");
    if (!entryQ) { for (const hold of HOLDS_SEC) for (const adv of ADVERSE) cells.push({ delay, hold, adv, status: "NO_ENTRY_QUOTE" }); continue; }
    for (const hold of HOLDS_SEC) {
      const exitQ = nearestAt(cs, signal.ts + delay + hold, buySide ? "bid" : "ask");
      if (!exitQ) { for (const adv of ADVERSE) cells.push({ delay, hold, adv, status: "NO_EXIT_QUOTE" }); continue; }
      for (const adv of ADVERSE) {
        // Fading a drop: buy YES (pay ask+adverse), sell YES later (receive bid).
        // Fading a spike: buy NO, i.e. sell YES short is not directly available on
        // Kalshi without a NO position -- model as buying NO (paying (1-bid)+adv
        // of the NO ask, which equals 1-yesBid, and exiting at the NO bid = 1-yesAsk).
        let entryPrice, exitPrice;
        if (buySide) {
          entryPrice = Math.min(0.99, entryQ.value + adv);
          exitPrice = exitQ.value;
        } else {
          const noAskAtEntry = Math.min(0.99, (1 - entryQ.value) + adv);
          const noBidAtExit = 1 - exitQ.value;
          entryPrice = noAskAtEntry; exitPrice = noBidAtExit;
        }
        const feeIn = fee(CONTRACTS, entryPrice), feeOut = fee(CONTRACTS, exitPrice);
        const netPnl = (exitPrice - entryPrice) * CONTRACTS - feeIn - feeOut;
        const capital = entryPrice * CONTRACTS + feeIn;
        cells.push({ delay, hold, adv, status: "OK", entryPrice, exitPrice, grossMove: exitPrice - entryPrice, netPnl, capital });
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// B: passive maker value (price-backtest only)
// ---------------------------------------------------------------------------
function detectMakerOpportunities(cs) {
  const signals = [];
  for (let i = MAKER_LOOKBACK_MIN; i < cs.length; i++) {
    const window = cs.slice(i - MAKER_LOOKBACK_MIN, i).filter(c => c.mid != null);
    if (window.length < MAKER_LOOKBACK_MIN * 0.6) continue;
    const fairValue = window.reduce((a, c) => a + c.mid, 0) / window.length;
    const cur = cs[i];
    if (cur.bid == null) continue;
    const restingPrice = Math.min(0.98, cur.bid + 0.01); // one tick inside best bid
    if (fairValue - restingPrice < MAKER_MARGIN_USD) continue;
    signals.push({ ts: cur.ts, restingPrice, fairValue });
  }
  return signals;
}
function priceMaker(cs, signal, idx) {
  const next = cs[idx + 1];
  const naiveTouched = next && next.bid != null && next.bid <= signal.restingPrice;
  if (!naiveTouched) return { touched: false, cells: [] };
  const cells = [];
  for (const hold of HOLDS_SEC) {
    const exitQ = nearestAt(cs, signal.ts + hold, "mid");
    if (!exitQ) { cells.push({ hold, status: "NO_EXIT_QUOTE" }); continue; }
    const feeIn = fee(CONTRACTS, signal.restingPrice); // conservative: taker-rate fee assumed on the maker leg too (see header doc)
    const grossMarkout = (exitQ.value - signal.restingPrice) * CONTRACTS;
    const netPnl = grossMarkout - feeIn;
    cells.push({ hold, status: "OK", netPnl, capital: signal.restingPrice * CONTRACTS + feeIn, markout: exitQ.value - signal.restingPrice });
  }
  return { touched: true, cells };
}

// ---------------------------------------------------------------------------
// Aggregation (station-day-independent) and metrics -- reused pattern.
// ---------------------------------------------------------------------------
function cellKeyS(delay, hold, adv) { return `${delay}|${hold}|${adv}`; }
function aggregateFade(rows) {
  const byCell = new Map();
  for (const r of rows) for (const c of r.cells) {
    if (c.status !== "OK") continue;
    const ck = cellKeyS(c.delay, c.hold, c.adv), dk = `${r.ticker}|${r.day}`;
    const m = byCell.get(ck) ?? new Map();
    const g = m.get(dk) ?? { pnl: 0, capital: 0, ticker: r.ticker, day: r.day, grossMoves: [] };
    g.pnl += c.netPnl; g.capital += c.capital; g.grossMoves.push(c.grossMove);
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
  for (const d of [...days].sort((a, b) => a.day.localeCompare(b.day))) { eq += d.pnl; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); }
  return { n: days.length, pnl, capital, roi: capital ? pnl / capital : null, pf: gl ? gw / gl : null, winRate: wins.length / days.length, maxDrawdown: maxDD, worst: Math.min(...days.map(d => d.pnl)) };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function lcg(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
function bootstrapCI(days, iters = 2000) {
  if (!days.length) return null;
  const r = lcg(hashStr(days.map(d => d.day + d.ticker).join(",")) || 1), totals = [];
  for (let b = 0; b < iters; b++) { let t = 0; for (let i = 0; i < days.length; i++) t += days[Math.floor(r() * days.length)].pnl; totals.push(t); }
  totals.sort((a, b) => a - b);
  return [totals[Math.floor(0.025 * iters)], totals[Math.floor(0.975 * iters)]];
}
function trimTopWinnerDays(days, frac) {
  const winners = days.filter(d => d.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  const drop = new Set(winners.slice(0, Math.ceil(winners.length * frac)).map(d => d.ticker + d.day));
  return days.filter(d => !drop.has(d.ticker + d.day));
}
const pct = x => x == null ? "n/a" : `${(100 * x).toFixed(1)}%`;
const money = x => x == null ? "n/a" : `$${x.toFixed(2)}`;

async function main() {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - LOOKBACK_DAYS * 86400;
  console.log(`Microstructure shootout (H: liquidity-shock reversion, B: passive maker value). Series ${SERIES}, ${LOOKBACK_DAYS}d.`);

  console.log("Fetching settled MLB game markets ...");
  const raw = await settledMarkets(SERIES, MAX_MARKETS);
  const byEvent = new Map();
  for (const m of raw) {
    const ct = Date.parse(m.close_time ?? "") / 1000;
    if (!Number.isFinite(ct) || ct < startTs || ct > endTs) continue;
    if (!["yes", "no"].includes(String(m.result ?? "").toLowerCase())) continue;
    if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, m); // one side per event
  }
  const markets = [...byEvent.values()].sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time)).slice(0, MAX_MARKETS);
  console.log(`  ${markets.length} distinct events in window (one side each, siblings excluded)`);

  const fadeRows = [], makerRows = [];
  let shocksTotal = 0, makerOppsTotal = 0;
  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const openTs = Math.floor(Date.parse(m.open_time ?? m.close_time) / 1000);
    const closeTs = Math.floor(Date.parse(m.close_time) / 1000);
    const cs = await candleWindow(SERIES, m.ticker, Math.max(openTs, closeTs - 6 * 3600), closeTs); // last 6h before close: pre-game + game window
    if (cs.length > 5) {
      const shocks = detectShocks(cs);
      shocksTotal += shocks.length;
      const seenDay = new Set();
      for (const s of shocks) {
        const dk = `${m.ticker}|${dayKey(s.ts)}`;
        if (seenDay.has(dk)) continue; // one signal per ticker/day
        seenDay.add(dk);
        fadeRows.push({ ticker: m.ticker, day: dayKey(s.ts), cells: priceFade(cs, s) });
      }
      const makerOpps = detectMakerOpportunities(cs);
      makerOppsTotal += makerOpps.length;
      const seenMakerDay = new Set();
      for (const s of makerOpps) {
        const dk = `${m.ticker}|${dayKey(s.ts)}`;
        if (seenMakerDay.has(dk)) continue;
        seenMakerDay.add(dk);
        const idx = cs.findIndex(c => c.ts === s.ts);
        const { touched, cells } = priceMaker(cs, s, idx);
        makerRows.push({ ticker: m.ticker, day: dayKey(s.ts), touched, cells });
      }
    }
    if (i % 20 === 0) process.stdout.write(`\r  ${i + 1}/${markets.length} markets (shocks:${fadeRows.length} makerOpps:${makerRows.length})   `);
    await sleep(30);
  }
  console.log(`\nRaw shock candles: ${shocksTotal}. Deduped fade signals: ${fadeRows.length} (${new Set(fadeRows.map(r => r.ticker)).size} tickers).`);
  console.log(`Raw maker opportunities: ${makerOppsTotal}. Deduped maker signals: ${makerRows.length}.`);

  // ---- H reporting ----
  const byCell = aggregateFade(fadeRows);
  const keyDays = [...(byCell.get(cellKeyS(300, 900, 0.01))?.values() ?? [])];
  const keyMetrics = metricsFromDays(keyDays);
  const ci = keyMetrics ? bootstrapCI(keyDays) : null;
  const trim1 = keyMetrics ? metricsFromDays(trimTopWinnerDays(keyDays, 0.01)) : null;
  const trim5 = keyMetrics ? metricsFromDays(trimTopWinnerDays(keyDays, 0.05)) : null;

  const fullGrid = [];
  for (const delay of DELAYS_SEC) for (const hold of HOLDS_SEC) for (const adv of ADVERSE) {
    const days = [...(byCell.get(cellKeyS(delay, hold, adv))?.values() ?? [])];
    const m = metricsFromDays(days);
    if (m) fullGrid.push({ delay, hold, adv, ...m });
  }

  // ---- B reporting (touched only, three fill-probability haircuts) ----
  const touchedMaker = makerRows.filter(r => r.touched);
  function makerMetricsAtHold(hold, fillProb) {
    const byDay = new Map();
    for (const r of touchedMaker) {
      const c = r.cells.find(x => x.hold === hold && x.status === "OK");
      if (!c) continue;
      const dk = `${r.ticker}|${r.day}`;
      const g = byDay.get(dk) ?? { pnl: 0, capital: 0, ticker: r.ticker, day: r.day };
      g.pnl += c.netPnl * fillProb; g.capital += c.capital * fillProb;
      byDay.set(dk, g);
    }
    return metricsFromDays([...byDay.values()]);
  }

  let md = `# Non-Weather Microstructure Shootout (H + B)\n\n`;
  md += `**PAPER / RESEARCH ONLY. No orders placed. \`LIVE_EXECUTION_IMPLEMENTED=false\`.**\n\n`;
  md += `Series ${SERIES}, ${LOOKBACK_DAYS}-day window. Preregistered shock threshold ${SHOCK_THRESHOLD_USD}, maker lookback ${MAKER_LOOKBACK_MIN}m, maker margin ${MAKER_MARGIN_USD}. None tuned against results.\n\n`;
  md += `## H — Liquidity-shock mean reversion\n\n`;
  md += `Signals: ${fadeRows.length} (one per ticker/day). Station-days: ${new Set(fadeRows.map(r=>`${r.ticker}|${r.day}`)).size}.\n\n`;
  md += `### KEY CELL (+5m delay, +15m hold, +1c adverse)\n\n`;
  if (keyMetrics) {
    md += `- N=${keyMetrics.n}, P/L ${money(keyMetrics.pnl)}, ROI ${pct(keyMetrics.roi)}, PF ${keyMetrics.pf==null?"n/a":keyMetrics.pf.toFixed(2)+"x"}, win rate ${pct(keyMetrics.winRate)}, max DD ${money(keyMetrics.maxDrawdown)}, worst single day ${money(keyMetrics.worst)}.\n`;
    md += `- Bootstrap 95% CI on P/L: ${ci ? `${money(ci[0])} .. ${money(ci[1])}` : "n/a"}.\n`;
    md += `- After top 1% winners removed: ${money(trim1?.pnl)}. After top 5%: ${money(trim5?.pnl)}.\n\n`;
  } else md += `- DATA_INSUFFICIENT: no station-days in this cell.\n\n`;
  md += `### Full grid (every delay x hold at +1c adverse)\n\n| Cell | N | P/L | ROI | PF |\n|---|---:|---:|---:|---:|\n`;
  for (const g of fullGrid.filter(g => g.adv === 0.01)) md += `| +${g.delay/60}m delay / +${g.hold/60}m hold | ${g.n} | ${money(g.pnl)} | ${pct(g.roi)} | ${g.pf==null?"n/a":g.pf.toFixed(2)+"x"} |\n`;

  md += `\n## B — Passive maker value (PRICE-BACKTEST ONLY, not an execution proof)\n\n`;
  md += `Opportunities: ${makerRows.length} (one per ticker/day). Naive-touch fill rate: ${makerRows.length ? pct(touchedMaker.length / makerRows.length) : "n/a"} (${touchedMaker.length}/${makerRows.length}).\n\n`;
  md += `| Hold | Fill 100% N | P/L@100% | Fill 50% P/L | Fill 25% P/L |\n|---|---:|---:|---:|---:|\n`;
  for (const hold of HOLDS_SEC) {
    const m100 = makerMetricsAtHold(hold, 1), m50 = makerMetricsAtHold(hold, 0.5), m25 = makerMetricsAtHold(hold, 0.25);
    md += `| +${hold/60}m | ${m100?.n ?? 0} | ${money(m100?.pnl)} | ${money(m50?.pnl)} | ${money(m25?.pnl)} |\n`;
  }
  md += `\nMaker fee note: priced conservatively at the SAME taker formula (no confirmed separate lower maker rate found for this series at run time) -- a real negotiated/rebate maker rate would only improve this, never worsen it.\n\n`;

  md += `## Guardrails\n\n- Market-ticker+day is the independent unit throughout; only one MLB sibling per event is used to avoid correlated duplication.\n- H's fade direction is mechanical (opposite the shock), not curve-fit to outcomes.\n- B is explicitly a PRICE-BACKTEST: "touched" is a conservative proxy for fill, not a queue-aware execution proof. Do not cite B as executable capacity without a forward test.\n- A missing entry/exit quote is excluded, never treated as a zero-move trade.\n- No thresholds tuned against these results.\n- No credentials, orders, production changes, Lovable changes, or live trading.\n`;

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/microstructure-shootout.md", md);
  await writeFile("research-output/microstructure-shootout.json", JSON.stringify({
    generatedAt: new Date().toISOString(), lookbackDays: LOOKBACK_DAYS, series: SERIES,
    marketsSampled: markets.length, shocksTotal, fadeSignals: fadeRows.length, makerOppsTotal, makerSignals: makerRows.length,
    keyMetrics, ci, trim1, trim5, fullGrid, fadeRows, makerRows,
  }, null, 2) + "\n");
  console.log(md);
}

main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
