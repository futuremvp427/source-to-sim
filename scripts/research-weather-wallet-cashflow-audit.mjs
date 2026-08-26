#!/usr/bin/env node

/**
 * Independent falsification of the /closed-positions realizedPnl wallet
 * reconstruction used by the earlier weather-candidate research.
 *
 * The earlier passes summed `realizedPnl` from the public
 * /closed-positions endpoint and treated `avgPrice * totalBought` as a cost
 * basis. This script rebuilds the SAME wallets from /activity instead, as a
 * literal cash ledger (BUY out, SELL/REDEEM/MERGE/CONVERSION in, SPLIT out),
 * and compares the two.
 *
 * The decisive check is coverage, not arithmetic: /closed-positions can only
 * report a position that actually closed. A wallet that abandons worthless
 * losing tokens instead of redeeming them never files those events, so the
 * endpoint reconstruction silently drops its losses.
 *
 * Research-only. No credentials, orders, production changes or live trading.
 */
import { mkdir, writeFile } from "node:fs/promises";

const DATA = "https://data-api.polymarket.com";
const LOOKBACK_DAYS = Number(process.env.WALLET_LOOKBACK_DAYS ?? "240");
const WALLETS = [
  ["Maskache2", "0x1f66796b45581868376365aef54b51eb84184c8d"],
  ["BeefSlayer", "0x331bf91c132af9d921e1908ca0979363fc47193f"],
  ["ColdMath", "0x594edb9112f526fa6a80b8f858a6379c8a2c1c11"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "source-to-sim-cashflow-audit/1.0" } });
      if (r.ok) return r.json();
      if (r.status === 400) return null; // offset ceiling
      last = new Error(`${r.status} ${r.statusText}`);
    } catch (e) {
      last = e;
    }
    await sleep(Math.min(8000, 400 * 2 ** i));
  }
  throw last;
}

const rowKey = (r) =>
  [r.transactionHash, r.asset, r.type, r.timestamp, r.side, r.size, r.usdcSize].join("|");

/** /activity caps `offset`, so walk backwards with an `end` timestamp cursor. */
async function activity(address, sinceTs) {
  const seen = new Set();
  const out = [];
  let end = null;
  for (;;) {
    let fresh = 0;
    for (let offset = 0; offset < 5000; offset += 500) {
      const p = new URLSearchParams({
        user: address, limit: "500", offset: String(offset),
        sortBy: "TIMESTAMP", sortDirection: "DESC",
      });
      if (end != null) p.set("end", String(end));
      const rows = await get(`${DATA}/activity?${p}`);
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) {
        const k = rowKey(r);
        if (!seen.has(k)) { seen.add(k); out.push(r); fresh++; }
      }
      if (rows.length < 500) break;
      await sleep(40);
    }
    if (!out.length) break;
    let oldest = Infinity;
    for (const r of out) if (r.timestamp < oldest) oldest = r.timestamp;
    if (oldest < sinceTs || fresh === 0) break;
    end = oldest;
  }
  return out.filter((r) => r.timestamp >= sinceTs);
}

async function closedPositions(address) {
  const seen = new Set();
  const out = [];
  for (let offset = 0; offset < 60000; offset += 50) {
    const p = new URLSearchParams({
      user: address, limit: "50", offset: String(offset),
      sortBy: "TIMESTAMP", sortDirection: "DESC",
    });
    const rows = await get(`${DATA}/closed-positions?${p}`);
    if (!Array.isArray(rows) || !rows.length) break;
    let fresh = 0;
    for (const r of rows) {
      const k = `${r.asset}|${r.conditionId}|${r.timestamp}`;
      if (!seen.has(k)) { seen.add(k); out.push(r); fresh++; }
    }
    if (rows.length < 50 || fresh === 0) break;
    await sleep(40);
  }
  return out;
}

/** Unredeemed inventory still sitting in the wallet, incl. worthless tokens. */
async function openPositions(address) {
  const out = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    const p = new URLSearchParams({ user: address, limit: "500", offset: String(offset), sizeThreshold: "0.01" });
    const rows = await get(`${DATA}/positions?${p}`);
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < 500) break;
    await sleep(40);
  }
  return out;
}

const isWeather = (t) => /highest temperature/i.test(t ?? "");

/** Signed cash delta for one activity row. Positive = USDC into the wallet. */
function cashDelta(r) {
  const u = Number(r.usdcSize ?? 0);
  if (!Number.isFinite(u)) return 0;
  switch (r.type) {
    case "TRADE": return r.side === "BUY" ? -u : u;
    case "REDEEM": case "MERGE": case "CONVERSION":
    case "REWARD": case "MAKER_REBATE": case "TAKER_REBATE":
    case "REFERRAL_REWARD": case "YIELD": return u;
    case "SPLIT": return -u;
    default: return 0;
  }
}

function band(price) {
  if (price < 0.05) return "<5c";
  if (price < 0.10) return "5-10c";
  if (price < 0.20) return "10-20c";
  if (price <= 0.55) return "20-55c";
  if (price < 0.90) return "55-90c";
  return ">=90c";
}

function metrics(values) {
  if (!values.length) return null;
  const wins = values.filter((v) => v > 0);
  const losses = values.filter((v) => v < 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = -losses.reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, maxDD = 0;
  for (const v of values) { eq += v; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); }
  return {
    events: values.length, winRate: wins.length / values.length,
    pnl: values.reduce((a, b) => a + b, 0), pf: gl ? gw / gl : null, maxDD,
  };
}

function bootstrapWinRate(values, n = 2000) {
  if (!values.length) return null;
  let s = 0x5eed1234 >>> 0;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const rates = [];
  for (let b = 0; b < n; b++) {
    let w = 0;
    for (let i = 0; i < values.length; i++) if (values[Math.floor(rnd() * values.length)] > 0) w++;
    rates.push(w / values.length);
  }
  rates.sort((a, b) => a - b);
  return [rates[Math.floor(0.025 * n)], rates[Math.floor(0.975 * n)]];
}

async function auditWallet(name, address, sinceTs) {
  const [act, closed, open] = [await activity(address, sinceTs), await closedPositions(address), await openPositions(address)];

  // Endpoint reconstruction, as used by the earlier research pass.
  const reported = new Map();
  for (const p of closed) {
    if (!isWeather(p.title)) continue;
    const k = p.eventSlug || p.conditionId;
    const g = reported.get(k) ?? { pnl: 0, cost: 0 };
    g.pnl += Number(p.realizedPnl ?? 0);
    g.cost += Number(p.avgPrice ?? 0) * Number(p.totalBought ?? 0);
    reported.set(k, g);
  }

  // Independent cash ledger from /activity.
  const truth = new Map();
  let walletNet = 0, weatherNet = 0;
  for (const r of act) {
    const d = cashDelta(r);
    walletNet += d;
    if (!isWeather(r.title)) continue;
    weatherNet += d;
    const k = r.eventSlug;
    if (!k) continue;
    const g = truth.get(k) ?? { cash: 0, buy: 0, qty: 0 };
    g.cash += d;
    if (r.type === "TRADE" && r.side === "BUY") { g.buy += Number(r.usdcSize ?? 0); g.qty += Number(r.size ?? 0); }
    truth.set(k, g);
  }

  const allEvents = [...truth.keys()];
  const covered = allEvents.filter((k) => reported.has(k));
  const missing = allEvents.filter((k) => !reported.has(k));
  const cashOf = (ks) => ks.map((k) => truth.get(k).cash);

  const worthless = open.filter((p) => Number(p.currentValue ?? 0) <= 0.01);
  const bands = {};
  for (const k of allEvents) {
    const g = truth.get(k);
    if (!g.qty) continue;
    const b = band(g.buy / g.qty);
    (bands[b] ??= []).push(g.cash);
  }

  return {
    name, address,
    walletNetCash: walletNet, weatherNetCash: weatherNet, nonWeatherNetCash: walletNet - weatherNet,
    activityRows: act.length, closedRows: closed.length,
    reportedEvents: reported.size,
    reportedPnl: [...reported.values()].reduce((a, g) => a + g.pnl, 0),
    reportedWinRate: reported.size ? [...reported.values()].filter((g) => g.pnl > 0).length / reported.size : null,
    trueEvents: allEvents.length,
    trueAll: metrics(cashOf(allEvents)),
    trueCovered: metrics(cashOf(covered)),
    trueMissing: metrics(cashOf(missing)),
    missingShare: allEvents.length ? missing.length / allEvents.length : null,
    bootstrapWinRate95: bootstrapWinRate(cashOf(allEvents)),
    unredeemedRows: open.length,
    unredeemedWorthless: worthless.length,
    unredeemedSunkCost: worthless.reduce((a, p) => a + Number(p.initialValue ?? 0), 0),
    unredeemedRecoverable: open.reduce((a, p) => a + Number(p.currentValue ?? 0), 0),
    bands: Object.fromEntries(Object.entries(bands).map(([b, v]) => [b, metrics(v)])),
  };
}

const pct = (x) => (x == null ? "n/a" : `${(100 * x).toFixed(1)}%`);
const money = (x) => (x == null ? "n/a" : `$${x.toFixed(2)}`);

async function main() {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
  const out = [];
  for (const [name, address] of WALLETS) {
    process.stdout.write(`Auditing ${name} ... `);
    out.push(await auditWallet(name, address, since));
    console.log("done");
  }

  let md = `# Weather Wallet Cash-Flow Audit\n\nIndependent falsification of the \`/closed-positions.realizedPnl\` reconstruction, using the public \`/activity\` ledger for the same wallets and the same ${LOOKBACK_DAYS}-day window.\n\n`;
  md += `Cash ledger convention: BUY is cash out; SELL, REDEEM, MERGE, CONVERSION and incentives are cash in; SPLIT is cash out. Terminal unredeemed inventory is reported separately.\n\n`;
  md += `| Wallet | Reported events | Reported P/L | Reported win | TRUE events | TRUE P/L | TRUE win | Events missing from /closed-positions | P/L hidden in those events |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const s of out) {
    md += `| ${s.name} | ${s.reportedEvents} | ${money(s.reportedPnl)} | ${pct(s.reportedWinRate)} | ${s.trueEvents} | ${money(s.trueAll?.pnl)} | ${pct(s.trueAll?.winRate)} | ${s.trueMissing?.events ?? 0} (${pct(s.missingShare)}) | ${money(s.trueMissing?.pnl)} |\n`;
  }

  for (const s of out) {
    md += `\n## ${s.name}\n\n`;
    md += `Whole-wallet net cash over the window: ${money(s.walletNetCash)} (weather ${money(s.weatherNetCash)}, non-weather ${money(s.nonWeatherNetCash)}). This is the tie-out constraint any event-level reconstruction must respect.\n\n`;
    md += `Unredeemed inventory: ${s.unredeemedRows} rows, of which ${s.unredeemedWorthless} are worthless, representing ${money(s.unredeemedSunkCost)} of gross buy cost that never becomes a closed position. Recoverable value ${money(s.unredeemedRecoverable)}.\n\n`;
    md += `Events present in \`/closed-positions\`: ${s.trueCovered?.events ?? 0}, true cash ${money(s.trueCovered?.pnl)}, true win ${pct(s.trueCovered?.winRate)}.\n\n`;
    md += `Events ABSENT from \`/closed-positions\`: ${s.trueMissing?.events ?? 0}, true cash ${money(s.trueMissing?.pnl)}, true win ${pct(s.trueMissing?.winRate)}.\n\n`;
    const ci = s.bootstrapWinRate95;
    md += `All events on the true ledger: ${s.trueAll?.events} events, win ${pct(s.trueAll?.winRate)}${ci ? ` (95% bootstrap ${pct(ci[0])}–${pct(ci[1])})` : ""}, P/L ${money(s.trueAll?.pnl)}, PF ${s.trueAll?.pf?.toFixed(2) ?? "n/a"}, max drawdown ${money(s.trueAll?.maxDD)}.\n\n`;
    md += `| Avg-buy-price band | Events | TRUE win rate | TRUE P/L | PF |\n|---|---:|---:|---:|---:|\n`;
    for (const b of ["<5c", "5-10c", "10-20c", "20-55c", "55-90c", ">=90c"]) {
      const m = s.bands[b];
      if (!m) continue;
      md += `| ${b} | ${m.events} | ${pct(m.winRate)} | ${money(m.pnl)} | ${m.pf?.toFixed(2) ?? "n/a"}x |\n`;
    }
  }

  md += `\n## Interpretation guardrails\n\n- A wallet that never redeems worthless tokens never files those events as closed positions, so \`/closed-positions\` is a survivorship-filtered view of that wallet, not a complete one.\n- The whole-wallet net cash figure is the binding constraint. Any per-event reconstruction that exceeds it is overstating.\n- These are international Polymarket contracts settled from Wunderground station data. Nothing here establishes executable P/L on a US venue, whose contracts settle from a different source.\n- Wallets were selected because they were already known to be profitable, so their historical economics are conditioned on success and are not an unbiased estimate of the strategy's forward expectancy.\n- No credentials, orders, production changes or live trading are used.\n`;

  await mkdir("research-output", { recursive: true });
  await writeFile("research-output/weather-wallet-cashflow-audit.md", md);
  await writeFile(
    "research-output/weather-wallet-cashflow-audit.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), lookbackDays: LOOKBACK_DAYS, wallets: out }, null, 2) + "\n",
  );
  console.log(md);
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
