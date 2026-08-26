#!/usr/bin/env node

/**
 * Live exhaustive-NO-basket scan with an explicit fee-floor calculation.
 *
 * Prior basket work established that no profitable complete basket was observed
 * prospectively. This script adds the reason: Kalshi's taker fee is rounded up to
 * the cent per contract, so even a basket priced exactly at fair value loses. It
 * reports, per event, the maximum sum of NO asks that could still be profitable.
 *
 * Read-only public market data. No credentials, orders or live trading.
 */
import { mkdir, writeFile } from "node:fs/promises";

const API = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = [
  ["NYC", "KXHIGHNY"], ["Chicago", "KXHIGHCHI"], ["LosAngeles", "KXHIGHLAX"],
  ["SanFrancisco", "KXHIGHTSFO"], ["Miami", "KXHIGHMIA"],
];
const SIZES = [1, 10, 25, 50, 100];
const PASSES = Number(process.env.BASKET_PASSES ?? "2");
const PASS_GAP_MS = Number(process.env.BASKET_PASS_GAP_MS ?? "60000");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "source-to-sim-basket-fee-floor/1.0" } });
      if (r.ok) return r.json();
      last = new Error(`${r.status} ${r.statusText}`);
    } catch (e) { last = e; }
    await sleep(Math.min(5000, 400 * 2 ** i));
  }
  throw last;
}

/** Kalshi taker fee in dollars: ceil(0.07 * P * (1-P) * C * 100) / 100. */
const takerFee = (price, contracts) => Math.ceil(0.07 * price * (1 - price) * contracts * 100) / 100;

/**
 * Buying NO means lifting the NO ask, which is the mirror of the resting YES bid.
 * `orderbook_fp.yes_dollars` is the YES bid ladder, so the NO ask ladder is
 * (1 - yesBidPrice) at the same size, cheapest NO ask first.
 */
function noAskLadder(orderbook) {
  const yesBids = orderbook?.yes_dollars ?? [];
  return yesBids
    .map(([p, s]) => [1 - Number(p), Number(s)])
    .sort((a, b) => a[0] - b[0]);
}

function walkLadder(ladder, size) {
  let need = size, cost = 0, fees = 0;
  for (const [price, avail] of ladder) {
    if (need <= 0) break;
    const take = Math.min(need, avail);
    cost += take * price;
    fees += takerFee(price, take);
    need -= take;
  }
  return need > 0 ? null : { cost, fees };
}

async function scanEvent(eventTicker, legs) {
  const started = Date.now();
  const books = [];
  for (const m of [...legs].sort((a, b) => a.ticker.localeCompare(b.ticker))) {
    const ob = (await get(`${API}/markets/${encodeURIComponent(m.ticker)}/orderbook?depth=100`)).orderbook_fp ?? {};
    books.push({ ticker: m.ticker, ladder: noAskLadder(ob) });
  }
  const fetchSpanMs = Date.now() - started;
  const missing = books.filter((b) => !b.ladder.length).map((b) => b.ticker);
  const payoutPerContract = legs.length - 1;

  if (missing.length) {
    return { eventTicker, legs: legs.length, complete: false, missing, fetchSpanMs, sizes: [] };
  }

  const bestSum = books.reduce((a, b) => a + b.ladder[0][0], 0);
  const sizes = SIZES.map((size) => {
    const parts = books.map((b) => walkLadder(b.ladder, size));
    if (parts.some((p) => p === null)) return { size, fillable: false };
    const cost = parts.reduce((a, p) => a + p.cost, 0);
    const fees = parts.reduce((a, p) => a + p.fees, 0);
    const payout = payoutPerContract * size;
    // Largest sum-of-NO-asks that could still break even at this size.
    const feeFloor = payoutPerContract - fees / size;
    return { size, fillable: true, cost, fees, payout, pnl: payout - cost - fees, feeFloorSumNoAsk: feeFloor };
  });

  return { eventTicker, legs: legs.length, complete: true, missing: [], fetchSpanMs, bestSumNoAsk: bestSum, payoutPerContract, sizes };
}

async function runPass(label) {
  const out = [];
  for (const [city, series] of SERIES) {
    const { markets = [] } = await get(`${API}/markets?series_ticker=${series}&status=open&limit=50`);
    const byEvent = new Map();
    for (const m of markets) {
      if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
      byEvent.get(m.event_ticker).push(m);
    }
    for (const [et, legs] of [...byEvent].sort()) {
      const meta = await get(`${API}/events/${encodeURIComponent(et)}`).catch(() => null);
      const r = await scanEvent(et, legs);
      out.push({
        pass: label, city, ...r,
        mutuallyExclusive: meta?.event?.mutually_exclusive ?? null,
        collateralReturnType: meta?.event?.collateral_return_type ?? null,
      });
    }
  }
  return out;
}

const money = (x) => (x == null ? "n/a" : `$${x.toFixed(2)}`);

async function main() {
  const passes = [];
  for (let i = 0; i < PASSES; i++) {
    if (i) await sleep(PASS_GAP_MS);
    process.stdout.write(`pass ${i + 1}/${PASSES} ... `);
    passes.push({ label: `P${i + 1}`, at: new Date().toISOString(), rows: await runPass(`P${i + 1}`) });
    console.log("done");
  }

  const all = passes.flatMap((p) => p.rows);
  const complete = all.filter((r) => r.complete);
  const profitable = complete.filter((r) => r.sizes.some((s) => s.fillable && s.pnl > 0));

  let md = `# Live Exhaustive-NO-Basket Scan with Fee Floor\n\nRead-only Kalshi public market data. ${PASSES} pass(es), ${PASS_GAP_MS / 1000}s apart.\n\n`;
  md += `Taker fee model: \`ceil(0.07 * P * (1-P) * C * 100) / 100\` dollars, rounded up per fill.\n\n`;
  md += `Because a complete six-leg NO basket has a deterministic payout, the basket is only profitable when the six best NO asks sum **below** the payout minus fees. That fee floor is reported per event.\n\n`;
  md += `## Summary\n\n- event scans: ${all.length}\n- complete-depth scans: ${complete.length}\n- **scans with any profitable fully fillable basket: ${profitable.length}**\n\n`;
  md += `| Pass | City | Event | Complete | Sum best NO ask | Payout | Fee floor @100/leg | P/L @1 | P/L @100 |\n|---|---|---|---|---:|---:|---:|---:|---:|\n`;
  for (const r of all) {
    const s1 = r.sizes.find((s) => s.size === 1);
    const s100 = r.sizes.find((s) => s.size === 100);
    md += `| ${r.pass} | ${r.city} | ${r.eventTicker} | ${r.complete ? "yes" : `no (${r.missing.length} legs)`} | ${r.complete ? money(r.bestSumNoAsk) : "n/a"} | ${r.payoutPerContract != null ? money(r.payoutPerContract) : "n/a"} | ${s100?.fillable ? money(s100.feeFloorSumNoAsk) : "n/a"} | ${s1?.fillable ? money(s1.pnl) : "n/a"} | ${s100?.fillable ? money(s100.pnl) : "n/a"} |\n`;
  }
  md += `\n## Interpretation\n\n- A basket priced exactly at fair value still loses, because the fee is charged on every leg and rounded up to the cent.\n- Legs missing from the book are real: extreme tail buckets frequently carry no resting YES bid, so no NO ask exists at any size.\n- A passive-maker version replaces deterministic payout with completion risk and is not equivalent.\n- No credentials, orders, production changes or live trading are used.\n`;

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-basket-fee-floor.md", md);
  await writeFile("research-output/weather-basket-fee-floor.json", JSON.stringify({ generatedAt: new Date().toISOString(), passes }, null, 2) + "\n");
  console.log(md);
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
