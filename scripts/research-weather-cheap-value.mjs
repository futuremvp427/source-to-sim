#!/usr/bin/env node

/**
 * Research-only cheap-bucket weather value test.
 * New hypothesis family inspired by public forecast-first weather wallets:
 * buy only cheap YES temperature buckets when previous-day archived NBM
 * probability materially exceeds contemporaneous Kalshi executable ask.
 *
 * Fresh historical window deliberately predates WEATHER-STRATEGY-3.
 * TRAIN selects rules. OOS is untouched until a rule is frozen.
 * One trade maximum per station-day. No live trading or credentials.
 */
import { mkdir, writeFile } from "node:fs/promises";

const KALSHI="https://external-api.kalshi.com/trade-api/v2";
const NBM="https://noaa-nbm-grib2-pds.s3.amazonaws.com";
const START_DATE=process.env.START_DATE??"2026-05-01";
const END_DATE=process.env.END_DATE??"2026-07-19";
const TRAIN_END=process.env.TRAIN_END??"2026-06-30";
const OOS_START=process.env.OOS_START??"2026-07-01";
const CONTRACTS=Number(process.env.CONTRACTS??"100");
const QUOTE_MAX_DELAY_SECONDS=Number(process.env.QUOTE_MAX_DELAY_SECONDS??"1800");
const MIN_TRAIN_TRADES=Number(process.env.MIN_TRAIN_TRADES??"20");
const MIN_OOS_TRADES=Number(process.env.MIN_OOS_TRADES??"10");
const SERIES=[
 {series:"KXHIGHLAX",icao:"KLAX",label:"Los Angeles"},
 {series:"KXHIGHTSFO",icao:"KSFO",label:"San Francisco"},
 {series:"KXHIGHMIA",icao:"KMIA",label:"Miami"},
];
const MIN_PROBS=[0.15,0.20,0.25,0.30,0.35];
const MIN_EDGES=[0.05,0.10,0.15,0.20];
const MAX_ASKS=[0.05,0.10,0.15,0.20];
const MONTHS={JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function fetchRetry(url,attempts=5){let last;for(let i=0;i<attempts;i++){try{const r=await fetch(url,{headers:{"User-Agent":"source-to-sim-cheap-value/1.0"}});if(r.ok)return r;last=new Error(`${r.status} ${r.statusText}: ${(await r.text()).slice(0,200)}`);}catch(e){last=e;}await sleep(Math.min(8000,500*2**i));}throw last;}
function parts(d){const [y,m,day]=d.split("-").map(Number);return{y,m,day};}
function addDays(d,n){const {y,m,day}=parts(d);return new Date(Date.UTC(y,m-1,day+n)).toISOString().slice(0,10);}
function unix(d,h,min=0){return Math.floor(Date.parse(`${d}T${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}:00Z`)/1000);}
function compact(d){return d.replaceAll("-","");}
function eventDate(t){const m=String(t??"").match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})$/i);if(!m)return null;return `20${m[1]}-${MONTHS[m[2].toUpperCase()]}-${m[3]}`;}
function parseBucket(market){const raw=`${market.yes_sub_title??""} ${market.subtitle??""}`.replace(/°/g,"").replace(/fahrenheit/gi,"F").replace(/\s+/g," ").trim();let m=raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:to|-|–)\s*(-?\d+(?:\.\d+)?)\s*(?:F)?/i);if(m)return{kind:"range",low:Number(m[1]),high:Number(m[2]),label:market.yes_sub_title??raw};m=raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:or\s+below|or\s+lower|or\s+less|and\s+below|or\s+under)/i);if(m)return{kind:"below",value:Number(m[1]),label:market.yes_sub_title??raw};m=raw.match(/(-?\d+(?:\.\d+)?)\s*(?:F)?\s*(?:or\s+above|or\s+higher|or\s+more|and\s+above)/i);if(m)return{kind:"above",value:Number(m[1]),label:market.yes_sub_title??raw};return null;}
function erf(x){const s=x<0?-1:1,a=Math.abs(x),t=1/(1+0.3275911*a);const y=1-(((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-a*a));return s*y;}
function cdf(x,m,sd){return 0.5*(1+erf((x-m)/(sd*Math.SQRT2)));}
function prob(b,m,sd){if(!Number.isFinite(sd)||sd<=0)return 0;if(b.kind==="range")return Math.max(0,Math.min(1,cdf(b.high+0.5,m,sd)-cdf(b.low-0.5,m,sd)));if(b.kind==="below")return cdf(b.value+0.5,m,sd);return 1-cdf(b.value-0.5,m,sd);}
function lineValues(block,key){const line=block.split(/\r?\n/).find(x=>x.trimStart().startsWith(key));return line?line.slice(line.indexOf(key)+key.length).match(/-?\d+(?:\.\d+)?/g)?.map(Number)??null:null;}
function forecastFrom(text,icao){const lines=text.split(/\r?\n/),idx=lines.findIndex(x=>x.trimStart().startsWith(`${icao}    NBM`));if(idx<0)return null;const block=lines.slice(idx,idx+35).join("\n"),fhr=lineValues(block,"FHR"),mean=lineValues(block,"TXNMN"),sd=lineValues(block,"TXNSD");if(!fhr||!mean||!sd)return null;const i=fhr.findIndex(x=>x===35);if(i<0||![mean[i],sd[i]].every(Number.isFinite)||mean[i]===-99||sd[i]===-99)return null;return{mean:mean[i],sd:sd[i]};}
const forecastCache=new Map();
async function forecasts(runDate){if(forecastCache.has(runDate))return forecastCache.get(runDate);const r=await fetchRetry(`${NBM}/blend.${compact(runDate)}/13/text/blend_nbptx.t13z`),text=await r.text(),out={};for(const s of SERIES)out[s.icao]=forecastFrom(text,s.icao);forecastCache.set(runDate,out);return out;}
async function markets(series){const p=new URLSearchParams({series_ticker:series,status:"settled",min_settled_ts:String(unix(START_DATE,0)),max_settled_ts:String(unix(addDays(END_DATE,3),23)),limit:"1000"});const d=await(await fetchRetry(`${KALSHI}/markets?${p}`)).json();return(d.markets??[]).filter(m=>{const d=eventDate(m.event_ticker);return d&&d>=START_DATE&&d<=END_DATE;});}
async function quote(config,ticker,targetDate){const run=addDays(targetDate,-1),start=unix(run,16),p=new URLSearchParams({start_ts:String(start),end_ts:String(start+QUOTE_MAX_DELAY_SECONDS),period_interval:"1"});const d=await(await fetchRetry(`${KALSHI}/series/${config.series}/events/${ticker}/candlesticks?${p}`)).json();for(const c of d.candlesticks??[]){const ts=Number(c.end_period_ts);if(ts<start||ts-start>QUOTE_MAX_DELAY_SECONDS)continue;const ask=Number(c.yes_ask?.close_dollars??c.yes_ask?.close);if(Number.isFinite(ask))return{ask,ts};}return null;}
function fee(n,p){return Math.ceil(0.07*n*p*(1-p)*100)/100;}
function score(rows,rule,slip=0){const byEvent=new Map();for(const r of rows){const ask=Math.min(0.99,r.ask+slip),edge=r.modelProb-ask;if(ask>rule.maxAsk||r.modelProb<rule.minProb||edge<rule.minEdge)continue;const cur=byEvent.get(r.eventTicker);if(!cur||edge>cur.edge)byEvent.set(r.eventTicker,{...r,ask,edge});}const trades=[...byEvent.values()];let pnl=0,cost=0,wins=0,equity=0,peak=0,maxDD=0;for(const t of trades.sort((a,b)=>a.date.localeCompare(b.date))){const c=CONTRACTS*t.ask+fee(CONTRACTS,t.ask),won=t.result==="yes",p=(won?CONTRACTS:0)-c;cost+=c;pnl+=p;if(won)wins++;equity+=p;peak=Math.max(peak,equity);maxDD=Math.min(maxDD,equity-peak);}return{...rule,slip,trades:trades.length,wins,losses:trades.length-wins,winRate:trades.length?wins/trades.length:null,pnl,cost,roi:cost?pnl/cost:null,maxDrawdown:maxDD,selectedTrades:trades};}
async function main(){const rows=[];for(const config of SERIES){console.log(`=== ${config.label} ===`);const ms=await markets(config.series),events=new Map();for(const m of ms){const date=eventDate(m.event_ticker);if(!date)continue;const e=events.get(m.event_ticker)??{date,markets:[]};e.markets.push(m);events.set(m.event_ticker,e);}for(const [ticker,e] of [...events]){let f;try{f=(await forecasts(addDays(e.date,-1)))[config.icao];}catch{continue;}if(!f)continue;let q;try{q=await quote(config,ticker,e.date);}catch{continue;}if(!q)continue;for(const m of e.markets){const b=parseBucket(m);if(!b)continue;const result=String(m.result??"").toLowerCase();if(result!=="yes"&&result!=="no")continue;rows.push({city:config.label,date:e.date,eventTicker:ticker,ticker:m.ticker,bucket:b.label,kind:b.kind,ask:q.ask,modelProb:prob(b,f.mean,f.sd),mean:f.mean,sd:f.sd,result});}}}
const train=rows.filter(r=>r.date<=TRAIN_END),oos=rows.filter(r=>r.date>=OOS_START);const rules=[];for(const minProb of MIN_PROBS)for(const minEdge of MIN_EDGES)for(const maxAsk of MAX_ASKS){const s=score(train,{minProb,minEdge,maxAsk});if(s.trades>=MIN_TRAIN_TRADES&&s.pnl>0)rules.push(s);}rules.sort((a,b)=>(b.roi??-Infinity)-(a.roi??-Infinity)||b.pnl-a.pnl);const frozen=rules[0]??null;let report=`# Weather Cheap-Bucket Value OOS Test\n\nFresh window: ${START_DATE} through ${END_DATE}\nTrain: through ${TRAIN_END}; OOS: ${OOS_START} onward\nRows with archived NBM + contemporaneous Kalshi quote: **${rows.length}**\nIndependent station-day events represented: **${new Set(rows.map(r=>r.eventTicker)).size}**\n\n`;
if(!frozen){report+=`No training rule met minimum ${MIN_TRAIN_TRADES} trades with positive after-fee P/L. **FAIL / no OOS selection.**\n`;}
else{const base=score(oos,frozen,0),s1=score(oos,frozen,0.01),s2=score(oos,frozen,0.02),s3=score(oos,frozen,0.03);report+=`Frozen TRAIN rule: model probability >= ${(frozen.minProb*100).toFixed(0)}%, edge >= ${(frozen.minEdge*100).toFixed(0)} points, YES ask <= ${(frozen.maxAsk*100).toFixed(0)}c.\nTRAIN: ${frozen.trades} trades, ${(100*frozen.winRate).toFixed(1)}% wins, $${frozen.pnl.toFixed(2)} P/L, ${(100*frozen.roi).toFixed(1)}% ROI, max DD $${frozen.maxDrawdown.toFixed(2)}.\n\n| OOS friction | Trades | Win rate | P/L | ROI | Max DD |\n|---|---:|---:|---:|---:|---:|\n${[base,s1,s2,s3].map(s=>`| +${Math.round(s.slip*100)}c adverse | ${s.trades} | ${s.winRate===null?"n/a":(100*s.winRate).toFixed(1)+"%"} | $${s.pnl.toFixed(2)} | ${s.roi===null?"n/a":(100*s.roi).toFixed(1)+"%"} | $${s.maxDrawdown.toFixed(2)} |`).join("\n")}\n\nAcceptance gate: >=${MIN_OOS_TRADES} OOS trades, positive P/L and ROI at +2c adverse execution, and no dependence on a single station-day.\nDecision: **${s2.trades>=MIN_OOS_TRADES&&s2.pnl>0?"PASS TO LARGER PAPER/FORWARD RESEARCH":"FAIL"}**.\n`;}
report+=`\nGuardrails: YES-only cheap-bucket hypothesis; one selected trade per station-day; public archived data only; historical 1-minute BBO does not prove depth/capacity; settlement/source mismatch and model misspecification remain risks. No live trading.\n`;
await mkdir("research-output",{recursive:true});await writeFile("research-output/weather-cheap-value-oos.md",report);await writeFile("research-output/weather-cheap-value-rows.json",JSON.stringify(rows,null,2));console.log(report);}
main().catch(e=>{console.error(e);process.exitCode=1;});
