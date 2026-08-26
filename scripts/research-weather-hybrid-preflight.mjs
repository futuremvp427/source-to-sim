#!/usr/bin/env node

/**
 * Historical implementation preflight for the proposed hybrid:
 * profitable source-wallet signal -> corresponding U.S. Kalshi daily-high
 * market -> contemporaneous U.S. quote -> (future Weather Lab validation).
 *
 * This script deliberately does NOT fabricate Weather Lab validation while the
 * station-basis forecast gate is still blocked. It answers the prior question:
 * is there enough target-market coverage, timing, quote availability and raw
 * U.S. economics to justify building/forward-testing the validation layer?
 *
 * Research only. Public endpoints only. No credentials, orders or production.
 */
import { mkdir, writeFile } from "node:fs/promises";

const DATA = "https://data-api.polymarket.com";
const K = "https://external-api.kalshi.com/trade-api/v2";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? "120");
const CONTRACTS = Number(process.env.CONTRACTS ?? "100");
const QUOTE_MAX_LAG_SECONDS = Number(process.env.QUOTE_MAX_LAG_SECONDS ?? "300");
const WALLETS = [
  ["BeefSlayer", "0x331bf91c132af9d921e1908ca0979363fc47193f"],
  ["ColdMath", "0x594edb9112f526fa6a80b8f858a6379c8a2c1c11"],
];
const CITIES = [
  { key: "NYC", names: ["new york city", "new york", "nyc"], series: "KXHIGHNY", corridor: false },
  { key: "CHI", names: ["chicago"], series: "KXHIGHCHI", corridor: false },
  { key: "LAX", names: ["los angeles"], series: "KXHIGHLAX", corridor: true },
  { key: "SFO", names: ["san francisco"], series: "KXHIGHTSFO", corridor: true },
  { key: "MIA", names: ["miami"], series: "KXHIGHMIA", corridor: true },
];
const MONTH = new Map([
  ["jan",1],["january",1],["feb",2],["february",2],["mar",3],["march",3],
  ["apr",4],["april",4],["may",5],["jun",6],["june",6],["jul",7],["july",7],
  ["aug",8],["august",8],["sep",9],["sept",9],["september",9],["oct",10],["october",10],
  ["nov",11],["november",11],["dec",12],["december",12],
]);
const MONTH3 = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "source-to-sim-hybrid-preflight/1.0" } });
      if (r.ok) return r.json();
      const body = await r.text();
      last = new Error(`${r.status} ${r.statusText}: ${body.slice(0, 180)}`);
      if (![429,500,502,503,504].includes(r.status)) throw last;
    } catch (e) { last = e; }
    await sleep(Math.min(10000, 500 * 2 ** i));
  }
  throw last;
}

const rowKey = (r) => [r.transactionHash,r.asset,r.type,r.timestamp,r.side,r.size,r.usdcSize].join("|");
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
      for (const r of rows) {
        const k = rowKey(r);
        if (!seen.has(k)) { seen.add(k); out.push(r); fresh++; }
      }
      if (rows.length < 500) break;
      await sleep(35);
    }
    if (!out.length) break;
    const oldest = Math.min(...out.map((r) => Number(r.timestamp)).filter(Number.isFinite));
    if (!Number.isFinite(oldest) || oldest < sinceTs || fresh === 0) break;
    end = oldest;
  }
  return out.filter((r) => Number(r.timestamp) >= sinceTs);
}

function cityOf(text) {
  const s = String(text ?? "").toLowerCase().replace(/[-_]/g, " ");
  for (const c of CITIES) if (c.names.some((n) => s.includes(n))) return c;
  return null;
}
function iso(y,m,d) {
  const dt = new Date(Date.UTC(y,m-1,d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m-1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}
function sourceDate(row) {
  const raw = `${row.eventSlug ?? ""} ${row.slug ?? ""} ${row.title ?? ""}`.toLowerCase().replace(/[-_/]/g, " ");
  let m = raw.match(/\b(20\d{2})\s+(\d{1,2})\s+(\d{1,2})\b/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = raw.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:\s+(20\d{2}))?\b/);
  if (m) {
    const month = MONTH.get(m[1]);
    let year = m[3] ? Number(m[3]) : new Date(Number(row.timestamp) * 1000).getUTCFullYear();
    const candidate = iso(year, month, Number(m[2]));
    if (candidate) return candidate;
  }
  // ISO date may have been destroyed by separator normalization; inspect raw fields again.
  const raw2 = `${row.eventSlug ?? ""} ${row.slug ?? ""} ${row.title ?? ""}`;
  m = raw2.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  return m ? iso(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
function parseBucket(text) {
  const raw = String(text ?? "").toLowerCase().replace(/[–—]/g,"-").replace(/degrees?/g,"°").replace(/fahrenheit/g,"f").replace(/\s+/g," ");
  let m = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:°?\s*f)?\s*(?:to|-)\s*(-?\d+(?:\.\d+)?)\s*°?\s*f\b/i);
  if (m) return { kind:"range", low:Number(m[1]), high:Number(m[2]), key:`range:${Number(m[1])}:${Number(m[2])}` };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:or\s+below|or\s+lower|or\s+less|and\s+below|or\s+under|or\s+fewer)/i);
  if (m) return { kind:"below", value:Number(m[1]), key:`below:${Number(m[1])}` };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*f?\s*(?:or\s+above|or\s+higher|or\s+more|and\s+above|or\s+over)/i);
  if (m) return { kind:"above", value:Number(m[1]), key:`above:${Number(m[1])}` };
  m = raw.match(/(-?\d+(?:\.\d+)?)\s*°\s*f\b/i);
  if (m) return { kind:"exact", value:Number(m[1]), key:`exact:${Number(m[1])}` };
  return null;
}
function sourceBucket(row) {
  // Some Polymarket weather rows put the bucket in outcome; binary rows put Yes/No there and the bucket in title.
  return parseBucket(row.outcome) ?? parseBucket(row.title) ?? parseBucket(row.slug);
}
function eventDate(ticker) {
  const m = String(ticker ?? "").match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})$/i);
  return m ? `20${m[1]}-${MONTH3[m[2].toUpperCase()]}-${m[3]}` : null;
}
function targetBucket(m) {
  return parseBucket(`${m.yes_sub_title ?? ""} ${m.subtitle ?? ""} ${m.title ?? ""}`);
}
function closeTs(m) {
  for (const k of ["close_time","expiration_time","expected_expiration_time","latest_expiration_time"]) {
    const t = Date.parse(m?.[k] ?? "");
    if (Number.isFinite(t)) return Math.floor(t/1000);
  }
  return null;
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
  const out = []; let cursor = null;
  do {
    const p = new URLSearchParams({ series_ticker: series, status: "settled", limit: "1000" });
    if (cursor) p.set("cursor", cursor);
    const d = await fetchJson(`${K}/markets?${p}`);
    out.push(...(d.markets ?? []));
    cursor = d.cursor || null;
    if (cursor) await sleep(40);
  } while (cursor);
  return out;
}
async function marketCatalog(series, startDate, endDate) {
  const both = [...await historicalMarkets(series), ...await currentSettledMarkets(series)];
  const byTicker = new Map(both.map((m) => [m.ticker, m]));
  const events = new Map();
  for (const m of byTicker.values()) {
    const date = eventDate(m.event_ticker);
    if (!date || date < startDate || date > endDate) continue;
    const b = targetBucket(m);
    if (!b) continue;
    const k = `${date}|${b.key}`;
    // Multiple same-key contracts would be unsafe; preserve ambiguity instead of silently choosing.
    const a = events.get(k) ?? [];
    a.push({ ...m, _date: date, _bucket: b, _series: series });
    events.set(k, a);
  }
  return events;
}
function askClose(c) {
  for (const x of [c?.yes_ask?.close_dollars, c?.yes_ask?.close, c?.yes_ask?.close_price]) {
    const n = Number(x); if (Number.isFinite(n)) return n;
  }
  return null;
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
      const cs = (d.candlesticks ?? []).map((c) => ({ ts:Number(c.end_period_ts), ask:askClose(c) })).filter((c) => Number.isFinite(c.ts) && c.ask != null).sort((a,b)=>a.ts-b.ts);
      if (cs.length) return cs;
    } catch {}
  }
  return [];
}
function askAt(candles, targetTs) {
  const c = candles.find((x) => x.ts >= targetTs && x.ts - targetTs <= QUOTE_MAX_LAG_SECONDS);
  return c ? { ask:c.ask, candleTs:c.ts, lagSeconds:c.ts-targetTs } : null;
}
function fee(contracts, price) {
  // Current API fee-rounding docs: trade fee rounded up to nearest $0.0001 per fill.
  const raw = 0.07 * contracts * price * (1-price);
  return Math.ceil(raw / 0.0001 - 1e-9) * 0.0001;
}
function simulate(rows, delaySeconds, slip) {
  const trades = [];
  for (const r of rows) {
    const q = r.quotes[String(delaySeconds)];
    if (!q) continue;
    const p = Math.min(0.99, q.ask + slip);
    const f = fee(CONTRACTS, p);
    const cost = CONTRACTS*p + f;
    const won = r.targetResult === "yes";
    trades.push({ ...r, execPrice:p, fee:f, pnl:(won?CONTRACTS:0)-cost, capital:cost });
  }
  const byDay = new Map();
  for (const t of trades) {
    const k = `${t.city}|${t.date}`;
    const g = byDay.get(k) ?? { pnl:0, capital:0, n:0, date:t.date };
    g.pnl += t.pnl; g.capital += t.capital; g.n++; byDay.set(k,g);
  }
  const days = [...byDay.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const pnl = trades.reduce((a,t)=>a+t.pnl,0), capital = trades.reduce((a,t)=>a+t.capital,0);
  const dayWins = days.filter((d)=>d.pnl>0).length;
  const gw = days.filter((d)=>d.pnl>0).reduce((a,d)=>a+d.pnl,0), gl = -days.filter((d)=>d.pnl<0).reduce((a,d)=>a+d.pnl,0);
  let eq=0,peak=0,maxDD=0; for (const d of days){eq+=d.pnl;peak=Math.max(peak,eq);maxDD=Math.min(maxDD,eq-peak);}
  return { delaySeconds, slip, signals:trades.length, stationDays:days.length, profitableDays:dayWins, profitableDayRate:days.length?dayWins/days.length:null, pnl, capital, roi:capital?pnl/capital:null, pf:gl?gw/gl:null, maxDrawdown:maxDD };
}
function pct(x){return x==null?"n/a":`${(100*x).toFixed(1)}%`;}
function money(x){return `$${x.toFixed(2)}`;}
function metricRow(m){return `| +${m.delaySeconds/60}m / +${Math.round(m.slip*100)}c | ${m.signals} | ${m.stationDays} | ${pct(m.profitableDayRate)} | ${money(m.pnl)} | ${pct(m.roi)} | ${m.pf==null?"n/a":m.pf.toFixed(2)+"x"} | ${money(m.maxDrawdown)} |`;}

async function main(){
  const endDate = new Date(Date.now()-86400_000).toISOString().slice(0,10);
  const startDate = new Date(Date.now()-LOOKBACK_DAYS*86400_000).toISOString().slice(0,10);
  const sinceTs = Math.floor(Date.parse(`${startDate}T00:00:00Z`)/1000);

  console.log(`Building Kalshi target catalog ${startDate}..${endDate}`);
  const catalogs = new Map();
  for (const c of CITIES) {
    process.stdout.write(`${c.key} ... `);
    const x = await marketCatalog(c.series,startDate,endDate); catalogs.set(c.key,x); console.log(`${x.size} date/bucket keys`);
  }

  const results=[];
  for (const [name,address] of WALLETS){
    process.stdout.write(`Fetching ${name} activity ... `);
    const act = await activity(address,sinceTs); console.log(`${act.length} rows`);
    const weatherTrades = act.filter((r)=>r.type==="TRADE" && /highest temperature/i.test(r.title??""));
    const buys = weatherTrades.filter((r)=>r.side==="BUY");
    const parsed=[]; const reject={};
    for (const r of buys){
      const c=cityOf(`${r.title??""} ${r.eventSlug??""}`); if(!c){reject.CITY_UNSUPPORTED=(reject.CITY_UNSUPPORTED??0)+1;continue;}
      const date=sourceDate(r); if(!date||date<startDate||date>endDate){reject.DATE_UNPARSED_OR_OUTSIDE=(reject.DATE_UNPARSED_OR_OUTSIDE??0)+1;continue;}
      const b=sourceBucket(r); if(!b){reject.BUCKET_UNPARSED=(reject.BUCKET_UNPARSED??0)+1;continue;}
      parsed.push({raw:r,city:c.key,series:c.series,corridor:c.corridor,date,bucket:b,ts:Number(r.timestamp),sourcePrice:Number(r.price),asset:r.asset});
    }
    // First BUY per city/date/bucket: DCA is not an independent signal.
    parsed.sort((a,b)=>a.ts-b.ts);
    const first=[]; const seen=new Set();
    for(const p of parsed){const k=`${p.city}|${p.date}|${p.bucket.key}`;if(seen.has(k))continue;seen.add(k);first.push(p);}
    const sellByAsset=new Map();
    for(const r of weatherTrades.filter((r)=>r.side==="SELL")){const a=sellByAsset.get(r.asset)??[];a.push(Number(r.timestamp));sellByAsset.set(r.asset,a);}

    const replay=[];
    for(let i=0;i<first.length;i++){
      const s=first[i]; const candidates=catalogs.get(s.city)?.get(`${s.date}|${s.bucket.key}`)??[];
      if(!candidates.length){reject.TARGET_BUCKET_NOT_FOUND=(reject.TARGET_BUCKET_NOT_FOUND??0)+1;continue;}
      if(candidates.length!==1){reject.TARGET_BUCKET_AMBIGUOUS=(reject.TARGET_BUCKET_AMBIGUOUS??0)+1;continue;}
      const target=candidates[0];
      const ct=closeTs(target);
      if(ct!=null&&s.ts>=ct){reject.TARGET_ALREADY_CLOSED=(reject.TARGET_ALREADY_CLOSED??0)+1;continue;}
      const result=String(target.result??"").toLowerCase();
      if(!["yes","no"].includes(result)){reject.TARGET_UNSETTLED=(reject.TARGET_UNSETTLED??0)+1;continue;}
      let candles=[]; try{candles=await candleWindow(s.series,target.ticker,s.ts-60,s.ts+20*60);}catch{}
      const quotes={}; for(const d of [0,60,300,900])quotes[String(d)]=askAt(candles,s.ts+d);
      if(!quotes["0"]){reject.NO_QUOTE_AT_SIGNAL=(reject.NO_QUOTE_AT_SIGNAL??0)+1;continue;}
      const sells=sellByAsset.get(s.asset)??[];
      replay.push({wallet:name,city:s.city,date:s.date,corridor:s.corridor,bucket:s.bucket.key,sourceTs:s.ts,sourcePrice:s.sourcePrice,targetTicker:target.ticker,targetResult:result,targetCloseTs:ct,quotes,sourceHadLaterSell:sells.some((x)=>x>s.ts)});
      if(i%20===0) process.stdout.write(".");
      await sleep(35);
    }
    console.log(`\n${name}: ${replay.length} quoted replay signals`);
    const metrics=[]; for(const d of [0,60,300,900])for(const slip of [0,.01,.02])metrics.push(simulate(replay,d,slip));
    const corridorReplay=replay.filter((r)=>r.corridor);
    const corridorMetrics=[]; for(const d of [0,60,300,900])for(const slip of [0,.01,.02])corridorMetrics.push(simulate(corridorReplay,d,slip));
    const diffs=replay.map((r)=>r.quotes["0"].ask-r.sourcePrice).filter(Number.isFinite);
    results.push({name,address,activityRows:act.length,weatherTradeRows:weatherTrades.length,weatherBuyRows:buys.length,parsedBuyRows:parsed.length,dedupedSignals:first.length,replaySignals:replay.length,replayStationDays:new Set(replay.map((r)=>`${r.city}|${r.date}`)).size,corridorSignals:corridorReplay.length,corridorStationDays:new Set(corridorReplay.map((r)=>`${r.city}|${r.date}`)).size,sourceLaterSellShare:replay.length?replay.filter((r)=>r.sourceHadLaterSell).length/replay.length:null,meanTargetAskMinusSourcePrice:diffs.length?diffs.reduce((a,b)=>a+b,0)/diffs.length:null,rejections:reject,metrics,corridorMetrics,replay});
  }

  let md=`# Wallet → U.S. Weather Hybrid Historical Preflight\n\nWindow: **${startDate} through ${endDate}** (${LOOKBACK_DAYS}d lookback). Public data only. This is an implementation-feasibility replay, not untouched OOS strategy proof.\n\n## What this test can and cannot prove\n\nIt uses actual source-wallet BUY timestamps, exact same-labeled Kalshi daily-high buckets, U.S. market results, and 1-minute YES-ask candlesticks. It directly tests the last-mile blockers we can test historically: target existence, bucket mapping, whether the U.S. market was still open, whether a quote existed after the source signal, latency, fees, and adverse price. Historical candlesticks **cannot prove order-book depth/queue fillability**, and Weather Lab model validation is not applied because the station-basis forecast gate is still intentionally blocked.\n\n`;
  for(const r of results){
    md+=`## ${r.name}\n\n- Activity rows: ${r.activityRows}; weather trades: ${r.weatherTradeRows}; weather BUY rows: ${r.weatherBuyRows}.\n- Parsed U.S.-city BUYs: ${r.parsedBuyRows}; first-per-city/date/bucket signals: ${r.dedupedSignals}.\n- Exact target-bucket + contemporaneous-quote replays: **${r.replaySignals} signals across ${r.replayStationDays} station-days**.\n- Previously audited same-airport corridors (LAX/SFO/MIA): **${r.corridorSignals} signals across ${r.corridorStationDays} station-days**.\n- Source later sold the same asset after the first BUY on ${pct(r.sourceLaterSellShare)} of replay signals; hold-to-settlement therefore differs from literal lifecycle-copy on that share.\n- Mean U.S. YES ask minus source-wallet fill price at signal: ${r.meanTargetAskMinusSourcePrice==null?"n/a":(100*r.meanTargetAskMinusSourcePrice).toFixed(1)+"c"}.\n- Rejections: ${Object.entries(r.rejections).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join(", ")||"none"}.\n\n### All five U.S. city triggers — fixed 100 contracts per first bucket BUY, held to U.S. settlement\n\n| Execution stress | Signals | Station-days | Profitable days | P/L | ROI | PF (day) | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${r.metrics.map(metricRow).join("\n")}\n\n### Audited same-airport corridors only (LAX/SFO/MIA)\n\n| Execution stress | Signals | Station-days | Profitable days | P/L | ROI | PF (day) | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${r.corridorMetrics.map(metricRow).join("\n")}\n\n`;
  }
  md+=`## Decision rules for build/no-build\n\nThis preflight is a **GO to finish the station-basis validation and start forward paper** only if at least one leading wallet has >=30 historical U.S. station-days with contemporaneous target quotes and the direct-copy diagnostic remains positive after +5m latency and +1c adverse execution. It is a **STOP / redesign trigger source** if the opportunity funnel collapses before that point. A GO is not evidence of a live-tradable edge; historical depth remains unresolved and must be measured prospectively.\n\n## Settlement correction\n\nCurrent Kalshi documentation states daily high/low temperature markets settle from the final **NWS Daily Climate Report**; The Weather Company applies to Kalshi's **hourly** temperature markets. Any earlier project assumption that current daily-high settlement universally moved to The Weather Company should be treated as superseded and checked per market rules.\n\nNo production code, Sports Shadow behavior, Lovable UI, credentials or live trading are touched.\n`;
  await mkdir("research-output",{recursive:true});
  await writeFile("research-output/weather-hybrid-preflight.md",md);
  await writeFile("research-output/weather-hybrid-preflight.json",JSON.stringify({generatedAt:new Date().toISOString(),startDate,endDate,lookbackDays:LOOKBACK_DAYS,contracts:CONTRACTS,results},null,2)+"\n");
  console.log(md);
}
main().catch((e)=>{console.error(e.stack||e);process.exitCode=1;});
