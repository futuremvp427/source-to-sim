#!/usr/bin/env node

/**
 * Research-only check of how much of the leading public weather-wallet evidence
 * comes from the five cities currently relevant to the PM-US daily-high set.
 * Uses public Polymarket /closed-positions and event-net aggregation. Diagnostic
 * only: source contracts can use different stations/rules, so this does not
 * claim copyability or US counterfactual P/L.
 */
import { mkdir, writeFile } from "node:fs/promises";
const DATA="https://data-api.polymarket.com";
const LIMIT=Number(process.env.WALLET_CLOSED_LIMIT??"10000");
const WALLETS=[
 ["Maskache2","0x1f66796b45581868376365aef54b51eb84184c8d"],
 ["ColdMath","0x594edb9112f526fa6a80b8f858a6379c8a2c1c11"],
 ["BeefSlayer","0x331bf91c132af9d921e1908ca0979363fc47193f"],
];
const TARGETS=new Map([
 ["new york city","NYC"],["new york","NYC"],
 ["san francisco","SF"],["miami","MIA"],
 ["chicago","CHI"],["los angeles","LA"],
]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url){for(let i=0;i<5;i++){try{const r=await fetch(url,{headers:{"User-Agent":"source-to-sim-us-transfer/1.0"}});if(r.ok)return r.json();if(![429,500,502,503,504].includes(r.status))throw new Error(`${r.status}: ${(await r.text()).slice(0,120)}`);}catch(e){if(i===4)throw e;}await sleep(Math.min(5000,400*2**i));}}
async function closed(address){const out=[];for(let offset=0;offset<LIMIT;offset+=50){const p=new URLSearchParams({user:address,limit:"50",offset:String(offset),sortBy:"TIMESTAMP",sortDirection:"DESC"}),x=await get(`${DATA}/closed-positions?${p}`);if(!Array.isArray(x)||!x.length)break;out.push(...x);if(x.length<50)break;await sleep(40);}return out;}
function city(title){const m=String(title??"").match(/highest temperature in (.+?) (?:be|on )/i);if(!m)return null;return m[1].trim().replace(/,?\s+(CA|FL|NY|IL)$/i,"").toLowerCase();}
function group(xs,key){const m=new Map();for(const x of xs){const k=key(x),a=m.get(k)??[];a.push(x);m.set(k,a);}return m;}
function metrics(events){const pnl=events.reduce((a,e)=>a+e.pnl,0),cost=events.reduce((a,e)=>a+e.cost,0),wins=events.filter(e=>e.pnl>0).length,grossW=events.filter(e=>e.pnl>0).reduce((a,e)=>a+e.pnl,0),grossL=-events.filter(e=>e.pnl<0).reduce((a,e)=>a+e.pnl,0);let eq=0,peak=0,dd=0;for(const e of [...events].sort((a,b)=>(a.ts??0)-(b.ts??0))){eq+=e.pnl;peak=Math.max(peak,eq);dd=Math.min(dd,eq-peak);}return{events:events.length,wins,winRate:events.length?wins/events.length:null,pnl,cost,roi:cost?pnl/cost:null,pf:grossL?grossW/grossL:null,maxDD:dd};}
function aggregate(rows){const out=[];for(const [id,ps] of group(rows,p=>p.eventSlug||p.conditionId)){const pnl=ps.reduce((a,p)=>a+Number(p.realizedPnl||0),0),cost=ps.reduce((a,p)=>a+(Number(p.avgPrice)||0)*(Number(p.totalBought)||0),0),c=city(ps[0]?.title),ts=Math.min(...ps.map(p=>Number(p.timestamp)||Infinity));out.push({id,city:c,target:TARGETS.get(c)||null,pnl,cost,ts:Number.isFinite(ts)?ts:null,positions:ps.length});}return out;}
const pct=x=>x==null?"n/a":`${(100*x).toFixed(1)}%`,money=x=>`$${x.toFixed(2)}`;
async function main(){const results=[];for(const [name,address] of WALLETS){process.stdout.write(`Fetching ${name} ... `);const rows=(await closed(address)).filter(p=>/highest temperature/i.test(p.title??""));console.log(rows.length);const events=aggregate(rows),target=events.filter(e=>e.target),non=events.filter(e=>!e.target),byCity=[...TARGETS.values()].filter((v,i,a)=>a.indexOf(v)===i).map(code=>{const x=target.filter(e=>e.target===code);return{code,...metrics(x)};});results.push({name,all:metrics(events),target:metrics(target),nonTarget:metrics(non),targetShare:events.length?target.length/events.length:null,targetPnlShare:metrics(events).pnl?metrics(target).pnl/metrics(events).pnl:null,byCity});}
let md=`# Leading Wallet US-City Transferability Stress\n\nPublic Polymarket closed-position event netting. Target set: NYC, San Francisco, Miami, Chicago, Los Angeles. Source contracts are **not** economically identical to US contracts; these numbers measure where the historical wallet evidence comes from, not US-copy P/L.\n\n| Wallet | All events | Target-city events | Target share | Target win rate | Target P/L | Target proxy ROI | Target PF | Target max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${results.map(r=>`| ${r.name} | ${r.all.events} | ${r.target.events} | ${pct(r.targetShare)} | ${pct(r.target.winRate)} | ${money(r.target.pnl)} | ${pct(r.target.roi)} | ${r.target.pf==null?"n/a":r.target.pf.toFixed(2)+"x"} | ${money(r.target.maxDD)} |`).join("\n")}\n`;
for(const r of results){md+=`\n## ${r.name}\n\n| City | Events | Win rate | P/L | Proxy ROI | PF |\n|---|---:|---:|---:|---:|---:|\n${r.byCity.map(c=>`| ${c.code} | ${c.events} | ${pct(c.winRate)} | ${money(c.pnl)} | ${pct(c.roi)} | ${c.pf==null?"n/a":c.pf.toFixed(2)+"x"} |`).join("\n")}\n`;}
md+=`\n## Guardrails\n\n- Different settlement station/source/window can reverse outcomes; this report never upgrades source-to-US settlement equivalence.\n- Endpoint realizedPnl and avgPrice×totalBought remain diagnostic accounting fields, not audited cash-flow reconstruction.\n- A wallet with strong global results but weak target-city results is a poor direct research prior for a US-only strategy.\n- No credentials, orders, deployment or live trading are used.\n`;
await mkdir("research-output",{recursive:true});await writeFile("research-output/weather-wallet-us-transfer.md",md);await writeFile("research-output/weather-wallet-us-transfer.json",JSON.stringify({generatedAt:new Date().toISOString(),results},null,2)+"\n");console.log(md);}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});