#!/usr/bin/env node

/**
 * Research-only realized-PnL decomposition for public Polymarket weather wallets.
 * Uses the official public Data API /closed-positions endpoint.
 * No credentials, orders, previews, or live trading.
 */

import { mkdir, writeFile } from "node:fs/promises";

const DATA = "https://data-api.polymarket.com";
const LOOKBACK_DAYS = Number(process.env.WALLET_LOOKBACK_DAYS ?? "180");
const MAX_POSITIONS = Number(process.env.WALLET_CLOSED_LIMIT ?? "5000");

const WALLETS = [
  ["HighTempTation", "0x6011655c4afb76f36dd1b08a137a1ba73466b31e"],
  ["Weatherstappen", "0xb9012e0d9b60d3920286309328b935cdfa609fc4"],
  ["BeefSlayer", "0x331bf91c132af9d921e1908ca0979363fc47193f"],
  ["JoeTheMeteorologist", "0x1838cca016850ac7185a9b149fe7d0bd2d6629b4"],
  ["ColdMath", "0x594edb9112f526fa6a80b8f858a6379c8a2c1c11"],
  ["Maskache2", "0x1f66796b45581868376365aef54b51eb84184c8d"],
  ["badatmath", "0x8fbd7cf5f806f563080864694415829f7229a959"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url, attempts = 5) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "source-to-sim-weather-research/1.0" } });
      if (r.ok) return r.json();
      const body = await r.text();
      last = new Error(`${r.status} ${r.statusText}: ${body.slice(0, 200)}`);
      if (![429,500,502,503,504].includes(r.status)) throw last;
    } catch (e) { last = e; }
    await sleep(Math.min(5000, 400 * 2 ** i));
  }
  throw last;
}

function weather(p) { return /highest temperature|lowest temperature|will it rain|precipitation|snow/i.test(p.title ?? ""); }
function highTemp(p) { return /highest temperature/i.test(p.title ?? ""); }
function groupBy(xs, fn) { const m = new Map(); for (const x of xs) { const k=fn(x); const a=m.get(k)??[]; a.push(x); m.set(k,a); } return m; }
function sum(xs, fn) { return xs.reduce((a,x)=>a+fn(x),0); }
function median(xs) { if(!xs.length)return null; const a=[...xs].sort((x,y)=>x-y),m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function pct(n,d){return d?100*n/d:null;}
function fmtPct(x){return x==null?"n/a":`${x.toFixed(1)}%`;}
function money(x){return `$${x.toFixed(2)}`;}
function priceBand(p){ const a=Number(p.avgPrice); if(a<.05)return "<5c"; if(a<.10)return "5-10c"; if(a<.20)return "10-20c"; if(a<=.55)return "20-55c"; if(a<.90)return "55-90c"; return ">=90c"; }

async function closedPositions(address) {
  const out=[];
  for(let offset=0; offset<MAX_POSITIONS; offset+=50){
    const q=new URLSearchParams({user:address,limit:"50",offset:String(offset),sortBy:"TIMESTAMP",sortDirection:"DESC"});
    const rows=await fetchRetry(`${DATA}/closed-positions?${q}`);
    if(!Array.isArray(rows)||!rows.length)break;
    out.push(...rows);
    if(rows.length<50)break;
    await sleep(80);
  }
  return out;
}

function summarize(name, positions){
  const cutoff=Date.now()-LOOKBACK_DAYS*86400_000;
  const wx=positions.filter(weather).filter(p=>{
    const ts=Number(p.timestamp)*1000;
    const end=Date.parse(p.endDate??"");
    const t=Number.isFinite(ts)&&ts>0?ts:end;
    return !Number.isFinite(t)||t>=cutoff;
  });
  const hi=wx.filter(highTemp);
  const rows=hi.map(p=>{
    const avgPrice=Number(p.avgPrice), totalBought=Number(p.totalBought), realizedPnl=Number(p.realizedPnl);
    const cost=Number.isFinite(avgPrice)&&Number.isFinite(totalBought)?avgPrice*totalBought:null;
    return {...p,avgPrice,totalBought,realizedPnl,cost,band:priceBand(p)};
  }).filter(p=>Number.isFinite(p.realizedPnl));
  const eventGroups=groupBy(rows,p=>p.eventSlug||p.conditionId);
  const events=[...eventGroups.entries()].map(([event,ps])=>({event,pnl:sum(ps,p=>p.realizedPnl),cost:sum(ps,p=>p.cost??0),positions:ps.length}));
  const posWins=rows.filter(p=>p.realizedPnl>0).length, posLosses=rows.filter(p=>p.realizedPnl<0).length;
  const eventWins=events.filter(e=>e.pnl>0).length,eventLosses=events.filter(e=>e.pnl<0).length;
  const grossWin=sum(events.filter(e=>e.pnl>0),e=>e.pnl),grossLoss=-sum(events.filter(e=>e.pnl<0),e=>e.pnl);
  const bands=[];
  for(const [band,ps] of groupBy(rows,p=>p.band)){
    const ev=[...groupBy(ps,p=>p.eventSlug||p.conditionId).values()].map(xs=>({pnl:sum(xs,p=>p.realizedPnl),cost:sum(xs,p=>p.cost??0)}));
    const pnl=sum(ev,e=>e.pnl),cost=sum(ev,e=>e.cost),wins=ev.filter(e=>e.pnl>0).length;
    bands.push({band,positions:ps.length,events:ev.length,wins,winRate:pct(wins,ev.length),pnl,cost,roi:cost>0?100*pnl/cost:null,profitFactor:(-sum(ev.filter(e=>e.pnl<0),e=>e.pnl))>0?sum(ev.filter(e=>e.pnl>0),e=>e.pnl)/(-sum(ev.filter(e=>e.pnl<0),e=>e.pnl)):null});
  }
  const sortedEvents=[...events].sort((a,b)=>a.pnl-b.pnl);
  return {name,positions:rows.length,events:events.length,posWinRate:pct(posWins,posWins+posLosses),eventWinRate:pct(eventWins,eventWins+eventLosses),pnl:sum(events,e=>e.pnl),cost:sum(events,e=>e.cost),approxRoi:sum(events,e=>e.cost)>0?100*sum(events,e=>e.pnl)/sum(events,e=>e.cost):null,profitFactor:grossLoss>0?grossWin/grossLoss:null,medianEventPnl:median(events.map(e=>e.pnl)),worstEvent:sortedEvents[0]??null,bestEvent:sortedEvents.at(-1)??null,bands:bands.sort((a,b)=>a.band.localeCompare(b.band)),eventsDetail:events};
}

async function main(){
  const summaries=[];
  for(const [name,address] of WALLETS){
    process.stdout.write(`Fetching ${name} closed positions ... `);
    const ps=await closedPositions(address);
    console.log(ps.length);
    summaries.push(summarize(name,ps));
  }
  const lines=["# Weather Wallet Realized-PnL Decomposition","",`Lookback: ${LOOKBACK_DAYS} days; public Data API closed positions; high-temperature markets only.`,`Approx ROI denominator = avgPrice × totalBought and is therefore a diagnostic cost proxy, not audited cash-flow accounting.`,"","| Wallet | Events | Event win | P/L | Approx ROI | Profit factor | Worst event | Best event |","|---|---:|---:|---:|---:|---:|---:|---:|"];
  for(const s of summaries)lines.push(`| ${s.name} | ${s.events} | ${fmtPct(s.eventWinRate)} | ${money(s.pnl)} | ${fmtPct(s.approxRoi)} | ${s.profitFactor==null?"n/a":s.profitFactor.toFixed(2)}x | ${s.worstEvent?money(s.worstEvent.pnl):"n/a"} | ${s.bestEvent?money(s.bestEvent.pnl):"n/a"} |`);
  for(const s of summaries){
    lines.push("",`## ${s.name}`,"","| Avg-price band | Events | Win rate | Realized P/L | Approx ROI | Profit factor |","|---|---:|---:|---:|---:|---:|");
    for(const b of s.bands)lines.push(`| ${b.band} | ${b.events} | ${fmtPct(b.winRate)} | ${money(b.pnl)} | ${fmtPct(b.roi)} | ${b.profitFactor==null?"n/a":b.profitFactor.toFixed(2)}x |`);
  }
  lines.push("","## Guardrails","","- Closed-position realized P/L captures the wallet's actual position lifecycle better than BUY-only reconstruction, but it is not proof that another venue offers the same prices, settlement rules, liquidity, or fillability.","- Event aggregation reduces double-counting when a wallet trades several buckets in the same daily-temperature event.","- Large positive realized P/L in cheap buckets is evidence for an asymmetric-value archetype, not evidence of a transferable forecasting signal by itself.","- No production or live-trading changes were made.");
  await mkdir("research-output",{recursive:true});
  await writeFile("research-output/weather-wallet-closed-positions.json",JSON.stringify({generatedAt:new Date().toISOString(),lookbackDays:LOOKBACK_DAYS,summaries},null,2)+"\n");
  await writeFile("research-output/weather-wallet-closed-positions.md",lines.join("\n")+"\n");
  console.log("\n"+lines.join("\n"));
}
main().catch(e=>{console.error(e?.stack??e);process.exitCode=1;});
