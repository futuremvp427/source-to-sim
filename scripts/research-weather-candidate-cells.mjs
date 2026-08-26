#!/usr/bin/env node

/**
 * Focused robustness diagnostics for the two leading source-wallet regime cells:
 *  A) Maskache2 NYC event-average 20-55c
 *  B) BeefSlayer NYC/CHI/MIA event-average 55-90c
 * Event-level public /closed-positions reconstruction only. This is not a US
 * counterfactual or audited cash ledger.
 */
import {mkdir,writeFile} from "node:fs/promises";
const DATA="https://data-api.polymarket.com",LIMIT=10000,BOOT=5000;
const SPECS=[
 {name:"Maskache2 NYC 20-55c",wallet:"0x1f66796b45581868376365aef54b51eb84184c8d",cities:new Set(["NYC"]),lo:.20,hi:.55},
 {name:"BeefSlayer NYC+CHI+MIA 55-90c",wallet:"0x331bf91c132af9d921e1908ca0979363fc47193f",cities:new Set(["NYC","CHI","MIA"]),lo:.55,hi:.90},
];
const CM=new Map([["new york city","NYC"],["new york","NYC"],["chicago","CHI"],["miami","MIA"],["san francisco","SF"],["los angeles","LA"]]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(u){let last;for(let i=0;i<5;i++){try{const r=await fetch(u,{headers:{"User-Agent":"source-to-sim-candidate-cells/1.0"}});if(r.ok)return r.json();last=new Error(`${r.status}: ${(await r.text()).slice(0,120)}`);}catch(e){last=e;}await sleep(Math.min(5000,350*2**i));}throw last;}
async function closed(w){const a=[];for(let o=0;o<LIMIT;o+=50){const p=new URLSearchParams({user:w,limit:"50",offset:String(o),sortBy:"TIMESTAMP",sortDirection:"DESC"}),x=await get(`${DATA}/closed-positions?${p}`);if(!Array.isArray(x)||!x.length)break;a.push(...x);if(x.length<50)break;await sleep(35);}return a;}
function city(t){const m=String(t??"").match(/highest temperature in (.+?) (?:be|on )/i);return m?CM.get(m[1].trim().replace(/,?\s+(CA|FL|NY|IL)$/i,"").toLowerCase())??null:null;}
function group(xs,f){const m=new Map();for(const x of xs){const k=f(x),a=m.get(k)??[];a.push(x);m.set(k,a);}return m;}
function events(rows){const a=[];for(const[id,ps]of group(rows,p=>p.eventSlug||p.conditionId)){const bought=ps.reduce((s,p)=>s+(Number(p.totalBought)||0),0),cost=ps.reduce((s,p)=>s+(Number(p.avgPrice)||0)*(Number(p.totalBought)||0),0),pnl=ps.reduce((s,p)=>s+(Number(p.realizedPnl)||0),0),ts=Math.min(...ps.map(p=>Number(p.timestamp)||Infinity));a.push({id,city:city(ps[0].title),avg:bought?cost/bought:0,cost,pnl,ts:Number.isFinite(ts)?ts:null});}return a;}
function met(xs){const pnl=xs.reduce((a,e)=>a+e.pnl,0),cost=xs.reduce((a,e)=>a+e.cost,0),wins=xs.filter(e=>e.pnl>0).length,gw=xs.filter(e=>e.pnl>0).reduce((a,e)=>a+e.pnl,0),gl=-xs.filter(e=>e.pnl<0).reduce((a,e)=>a+e.pnl,0);let eq=0,peak=0,dd=0;for(const e of [...xs].sort((a,b)=>(a.ts??0)-(b.ts??0))){eq+=e.pnl;peak=Math.max(peak,eq);dd=Math.min(dd,eq-peak);}return{n:xs.length,wr:xs.length?wins/xs.length:null,pnl,roi:cost?pnl/cost:null,pf:gl?gw/gl:null,dd};}
function q(a,p){if(!a.length)return null;const x=[...a].sort((a,b)=>a-b),i=Math.floor((x.length-1)*p);return x[Math.max(0,Math.min(x.length-1,i))];}
function rng(seed=0x1234abcd){let s=seed>>>0;return()=>((s=(1664525*s+1013904223)>>>0)/4294967296);}
function boot(xs){const r=rng(),wr=[],mean=[];for(let b=0;b<BOOT;b++){let w=0,p=0;for(let i=0;i<xs.length;i++){const e=xs[Math.floor(r()*xs.length)];if(e.pnl>0)w++;p+=e.pnl;}wr.push(w/xs.length);mean.push(p/xs.length);}return{wr95:[q(wr,.025),q(wr,.975)],meanPnl95:[q(mean,.025),q(mean,.975)]};}
function trim(xs,pct){const w=[...xs].filter(e=>e.pnl>0).sort((a,b)=>b.pnl-a.pnl),drop=Math.ceil(w.length*pct),ids=new Set(w.slice(0,drop).map(e=>e.id));return met(xs.filter(e=>!ids.has(e.id)));}
const pct=x=>x==null?"n/a":`${(100*x).toFixed(1)}%`,money=x=>`$${x.toFixed(2)}`;
async function main(){const results=[];for(const spec of SPECS){const all=events((await closed(spec.wallet)).filter(p=>/highest temperature/i.test(p.title??""))),x=all.filter(e=>spec.cities.has(e.city)&&e.avg>=spec.lo&&e.avg<spec.hi).sort((a,b)=>(a.ts??0)-(b.ts??0)),m=met(x),b=boot(x),half=Math.floor(x.length/2),first=met(x.slice(0,half)),second=met(x.slice(half)),months=[...group(x,e=>new Date((e.ts??0)*1000).toISOString().slice(0,7))].map(([month,z])=>({month,...met(z)})).sort((a,b)=>a.month.localeCompare(b.month)),byCity=[...group(x,e=>e.city)].map(([city,z])=>({city,...met(z)}));results.push({...spec,n:m.n,overall:m,bootstrap:b,first,second,trim1:trim(x,.01),trim5:trim(x,.05),months,byCity});}
let md=`# Focused Candidate-Cell Robustness\n\nPublic source-wallet event reconstruction only; no U.S.-venue settlement equivalence or executable price is assumed. 5,000 event bootstraps per cell.\n\n| Candidate cell | Events | Win | P/L | Proxy ROI | PF | Max DD | 95% bootstrap win CI | P/L after top 5% winners removed |\n|---|---:|---:|---:|---:|---:|---:|---|---:|\n${results.map(r=>`| ${r.name} | ${r.overall.n} | ${pct(r.overall.wr)} | ${money(r.overall.pnl)} | ${pct(r.overall.roi)} | ${r.overall.pf==null?"n/a":r.overall.pf.toFixed(2)+"x"} | ${money(r.overall.dd)} | ${pct(r.bootstrap.wr95[0])}-${pct(r.bootstrap.wr95[1])} | ${money(r.trim5.pnl)} |`).join("\n")}\n`;
for(const r of results){md+=`\n## ${r.name}\n\nFirst half: ${r.first.n} events, ${pct(r.first.wr)}, ${money(r.first.pnl)}, PF ${r.first.pf==null?"n/a":r.first.pf.toFixed(2)+"x"}.\n\nSecond half: ${r.second.n} events, ${pct(r.second.wr)}, ${money(r.second.pnl)}, PF ${r.second.pf==null?"n/a":r.second.pf.toFixed(2)+"x"}.\n\nP/L after removing top 1% winners: ${money(r.trim1.pnl)}; after top 5% winners: ${money(r.trim5.pnl)}.\n\n| Month | Events | Win | P/L | PF |\n|---|---:|---:|---:|---:|\n${r.months.map(m=>`| ${m.month} | ${m.n} | ${pct(m.wr)} | ${money(m.pnl)} | ${m.pf==null?"n/a":m.pf.toFixed(2)+"x"} |`).join("\n")}\n\n| City | Events | Win | P/L | PF |\n|---|---:|---:|---:|---:|\n${r.byCity.map(c=>`| ${c.city} | ${c.n} | ${pct(c.wr)} | ${money(c.pnl)} | ${c.pf==null?"n/a":c.pf.toFixed(2)+"x"} |`).join("\n")}\n`;}
md+=`\nGuardrails: bootstrap resamples endpoint events, not future market regimes. Chronological halves/months are stability diagnostics, not untouched OOS. Any implementation must use exact U.S. settlement rules, target quotes/depth, and new forward/OOS evidence. No orders or credentials used.\n`;
await mkdir("research-output",{recursive:true});await writeFile("research-output/weather-candidate-cells.md",md);await writeFile("research-output/weather-candidate-cells.json",JSON.stringify({generatedAt:new Date().toISOString(),results},null,2)+"\n");console.log(md);}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});