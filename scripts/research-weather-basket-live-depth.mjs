#!/usr/bin/env node

/**
 * Read-only, unauthenticated current-orderbook depth scanner for Kalshi daily
 * temperature exhaustive-bucket NO baskets. It never signs, previews, or sends
 * an order. Purpose: falsify historical candle arbitrage by requiring all-leg
 * live depth at one scan snapshot.
 */
const API="https://external-api.kalshi.com/trade-api/v2";
const SERIES=["KXHIGHNY","KXHIGHCHI","KXHIGHLAX","KXHIGHTSFO","KXHIGHMIA"];
const SIZES=[1,5,10,25,50,100];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url){let last;for(let i=0;i<4;i++){try{const r=await fetch(url,{headers:{"User-Agent":"source-to-sim-weather-depth-research/1.0"}});if(r.ok)return r.json();last=new Error(`${r.status} ${r.statusText}: ${(await r.text()).slice(0,200)}`);}catch(e){last=e;}await sleep(Math.min(4000,350*2**i));}throw last;}
function num(x){const n=Number(x);return Number.isFinite(n)?n:null;}
function fee(n,p){return Math.ceil(0.07*n*p*(1-p)*100)/100;}
async function markets(series){const p=new URLSearchParams({series_ticker:series,status:"open",limit:"1000"});return (await get(`${API}/markets?${p}`)).markets??[];}
async function book(ticker){return (await get(`${API}/markets/${encodeURIComponent(ticker)}/orderbook?depth=100`)).orderbook_fp??{};}
function noAskLevels(orderbook){const yes=(orderbook.yes_dollars??[]).map(([p,q])=>({ask:1-Number(p),qty:Number(q)})).filter(x=>Number.isFinite(x.ask)&&Number.isFinite(x.qty)&&x.qty>0);return yes.sort((a,b)=>a.ask-b.ask);}
function fillCost(levels,target){let left=target,cost=0,fees=0,filled=0;for(const l of levels){if(left<=1e-9)break;const q=Math.min(left,l.qty);cost+=q*l.ask;fees+=fee(q,l.ask);filled+=q;left-=q;}return{fillable:left<=1e-9,filled,cost:cost+fees,raw:cost,fees,worst:filled?Math.max(...levels.filter((_,i)=>{let s=0;for(let j=0;j<=i;j++)s+=levels[j].qty;return s<=target+levels[i].qty}).map(x=>x.ask)):null};}
function looksExhaustive(ms){if(ms.length<3)return false;const subtitles=ms.map(m=>String(m.yes_sub_title??m.subtitle??""));const hasLower=subtitles.some(s=>/below|lower|less|under/i.test(s));const hasUpper=subtitles.some(s=>/above|higher|more/i.test(s));const ranges=subtitles.filter(s=>/\d+\s*(?:°?F)?\s*(?:to|-|–)\s*\d+/i.test(s)).length;return hasLower&&hasUpper&&ranges>=1;}
async function main(){const rows=[];for(const series of SERIES){let ms=[];try{ms=await markets(series);}catch(e){rows.push({series,error:`MARKETS:${e.message}`});continue;}const groups=new Map();for(const m of ms){const a=groups.get(m.event_ticker)??[];a.push(m);groups.set(m.event_ticker,a);}for(const [eventTicker,eventMarkets] of groups){if(!looksExhaustive(eventMarkets)){rows.push({series,eventTicker,legs:eventMarkets.length,status:"REJECT_SHAPE"});continue;}const levels=[];let failed=null;for(const m of eventMarkets){try{const b=await book(m.ticker);const l=noAskLevels(b);if(!l.length){failed=`NO_YES_BIDS:${m.ticker}`;break;}levels.push({ticker:m.ticker,levels:l,best:l[0]});}catch(e){failed=`BOOK:${m.ticker}:${e.message}`;break;}await sleep(60);}if(failed){rows.push({series,eventTicker,legs:eventMarkets.length,status:"NO_COMPLETE_DEPTH",reason:failed});continue;}const sizes={};for(const q of SIZES){const fills=levels.map(l=>fillCost(l.levels,q));if(fills.every(f=>f.fillable)){const total=fills.reduce((a,f)=>a+f.cost,0),gross=q*(eventMarkets.length-1),profit=gross-total;sizes[q]={fillable:true,totalCost:total,grossPayout:gross,profit,roi:total?profit/total:null,legFees:fills.reduce((a,f)=>a+f.fees,0),bestNoAsks:levels.map(l=>l.best.ask)};}else sizes[q]={fillable:false,legsFilled:fills.filter(f=>f.fillable).length};}rows.push({series,eventTicker,legs:eventMarkets.length,status:"COMPLETE_DEPTH",sizes});}}
console.log("# Live Read-Only Weather NO-Basket Depth Scan");console.log(`Timestamp: ${new Date().toISOString()}`);console.log("No authenticated endpoints, previews, or orders used.\n");for(const r of rows){console.log(`## ${r.series} ${r.eventTicker??""} — ${r.status}`);if(r.reason)console.log(r.reason);if(r.sizes){for(const q of SIZES){const s=r.sizes[q];if(s?.fillable)console.log(`${q} contracts/leg: cost=$${s.totalCost.toFixed(2)} payout=$${s.grossPayout.toFixed(2)} profit=$${s.profit.toFixed(2)} ROI=${(100*s.roi).toFixed(3)}% fees=$${s.legFees.toFixed(2)}`);else console.log(`${q} contracts/leg: NOT FULLY FILLABLE (${s?.legsFilled??0}/${r.legs} legs)`);}console.log(`best NO asks: ${r.sizes[1]?.bestNoAsks?.map(x=>(100*x).toFixed(1)+"c").join(", ")??"n/a"}`);}console.log();}
console.log("Guardrail: this scanner is a single sequential snapshot; even if every leg shows depth, the quotes are not atomic and can move between requests. Positive output qualifies only for repeated prospective paper observation.");
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
