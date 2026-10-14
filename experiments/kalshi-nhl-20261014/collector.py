#!/usr/bin/env python3
"""GET-only NHL data rehearsal. No execution, account mutations or profit scoring."""
from __future__ import annotations
import argparse, concurrent.futures, gzip, hashlib, json, math, os, shutil, signal, threading, time
import urllib.error, urllib.parse, urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parent
KALSHI="https://external-api.kalshi.com/trade-api/v2"
NHL="https://api-web.nhle.com/v1"
STOP=False

def canonical(x): return json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
def digest(x): return hashlib.sha256(x).hexdigest()
def utc(t=None): return datetime.fromtimestamp(time.time() if t is None else t,timezone.utc).isoformat()
def epoch(x):
    if not isinstance(x,str): return None
    try: return datetime.fromisoformat(x.replace("Z","+00:00")).timestamp()
    except ValueError: return None
def source_time(body):
    # Deliberately do not invent a source timestamp from HTTP Date or clock time.
    for obj in (body,body.get("clock",{})):
        for key in ("lastUpdated","updatedAt","updateTime","last_update_utc"):
            stamp=epoch(obj.get(key)) if isinstance(obj,dict) else None
            if stamp is not None: return stamp
    return None
def parse_clock(body):
    period=body.get("periodDescriptor",{}).get("number")
    clock=body.get("clock",{})
    seconds=clock.get("secondsRemaining")
    if seconds is None:
        text=clock.get("timeRemaining","")
        try:
            minute,second=map(int,text.split(":")); seconds=60*minute+second
        except (ValueError,AttributeError): seconds=None
    if isinstance(seconds,bool) or not isinstance(seconds,(int,float)) or not 0<=seconds<=1200: seconds=None
    return {"period":period,"seconds_remaining":seconds,"running":clock.get("running"),"source_at":source_time(body),"live_state":body.get("gameState")}
def parse_book(body):
    book=body.get("orderbook_fp")
    if not isinstance(book,dict): raise ValueError("missing fixed-point book")
    out={}
    for side in ("yes","no"):
        seen=set(); levels=[]
        for price,qty in book.get(side+"_dollars",[]):
            p,q=Decimal(str(price)),Decimal(str(qty)); raw=p*10000
            if not p.is_finite() or not q.is_finite() or raw!=raw.to_integral_value() or not 0<p<1 or q<0: raise ValueError("invalid price/quantity")
            if q:
                if int(raw) in seen: raise ValueError("duplicate price")
                seen.add(int(raw)); levels.append([int(raw),str(q)])
        out[side]=sorted(levels,reverse=True)
    if not out["yes"] or not out["no"]: raise ValueError("one-sided book")
    y,n=out["yes"][0][0],out["no"][0][0]
    if y+n>=10000: raise ValueError("crossed or locked book")
    out.update(yes_bid=y,yes_ask=10000-n,no_bid=n,no_ask=10000-y,spread=10000-n-y)
    return out
def allowed(url):
    u=urllib.parse.urlsplit(url)
    return u.scheme=="https" and not u.username and not u.password and ((u.netloc=="external-api.kalshi.com" and u.path.startswith("/trade-api/v2/") and not any(x in u.path for x in ("/portfolio","/orders","/api-keys"))) or (u.netloc=="api-web.nhle.com" and (u.path.startswith("/v1/score/") or (u.path.startswith("/v1/gamecenter/") and u.path.endswith("/landing")))))

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        raise ValueError("HTTP redirect not permitted")

class Network:
    def __init__(self,protocol): self.p=protocol; self.lock=threading.Lock(); self.next_request=0
    def get(self,url):
        if not allowed(url): raise ValueError("URL outside public GET allowlist")
        with self.lock:
            now=time.monotonic(); delay=max(0,self.next_request-now); self.next_request=max(now,self.next_request)+1/self.p["maximum_requests_per_second"]
        if delay: time.sleep(delay)
        sent=time.time(); start=time.monotonic(); body=None; status=None; headers={}; error=None
        try:
            req=urllib.request.Request(url,headers={"User-Agent":"NHL-paper-data-rehearsal/1.0","Accept":"application/json"},method="GET")
            with urllib.request.build_opener(NoRedirect()).open(req,timeout=self.p["network_timeout_seconds"]) as resp:
                if not allowed(resp.geturl()): raise ValueError("redirect outside allowlist")
                status=resp.status; headers={k.lower():v for k,v in resp.headers.items() if k.lower() in ("date","age","cache-control","last-modified","etag")}
                data=resp.read(self.p["maximum_response_bytes"]+1)
                if len(data)>self.p["maximum_response_bytes"]: raise ValueError("response byte cap")
                body=json.loads(data)
        except urllib.error.HTTPError as exc:
            status=exc.code; error=f"HTTPError: {exc}"
        except Exception as exc: error=f"{type(exc).__name__}: {exc}"
        return {"url":url,"sent_at":sent,"received_at":time.time(),"request_seconds":time.monotonic()-start,"http_status":status,"headers":headers,"body":body,"error":error}

class Journal:
    def __init__(self,state): self.s=state; self.rows=[]; self.start_head=state["raw_hash"]; self.start_seq=state["raw_seq"]
    def add(self,kind,payload):
        row={"seq":self.s["raw_seq"]+1,"prev_hash":self.s["raw_hash"],"kind":kind,"payload":payload}
        row["hash"]=digest(canonical(row)); encoded=canonical(row)
        self.rows.append(encoded+b"\n"); self.s["raw_hash"]=row["hash"]; self.s["raw_seq"]=row["seq"]
        self.s["raw_bytes"]+=len(encoded)+1
        if kind=="http":
            self.s["health"]["http_calls"]+=1
            if payload.get("error") or payload.get("http_status")!=200: self.s["health"]["http_errors"]+=1
            else: self.s["last_successful_http_at"]=payload["received_at"]
        return payload

def verify_raw(path,previous):
    n=0; head=previous
    with gzip.open(path,"rt") as f:
        for line in f:
            row=json.loads(line); actual=row.pop("hash")
            if row["prev_hash"]!=head or digest(canonical(row))!=actual: raise ValueError("broken raw hash chain")
            head=actual; n+=1
    return n,head
def verify_checkpoint(folder):
    folder=Path(folder); manifest=json.loads((folder/"manifest.json").read_text())
    for name,expected in manifest["files"].items():
        if Path(name).name!=name or digest((folder/name).read_bytes())!=expected: raise ValueError("manifest mismatch")
    n,head=verify_raw(folder/"observations.jsonl.gz",manifest["raw_previous_hash"])
    state=json.loads((folder/"state.json").read_text())
    if head!=state["raw_hash"] or n!=manifest["raw_records"]: raise ValueError("raw/state mismatch")
    return state

def game_key(g):
    try:
        date=datetime.fromisoformat(g["gameDate"]).strftime("%y%b%d").upper()
        return "KXNHLGAME-"+date+g["awayTeam"]["abbrev"]+g["homeTeam"]["abbrev"]
    except (KeyError,ValueError): return None
def fresh_response(row,now,maximum):
    if row.get("error") or row.get("http_status")!=200 or not isinstance(row.get("body"),dict): return False
    age=row.get("headers",{}).get("age")
    try:
        if age is not None and float(age)>maximum: return False
    except ValueError: return False
    return 0<=now-row["received_at"]<=maximum

class Collector:
    def __init__(self,p,state,network): self.p=p; self.s=state; self.net=network; self.j=Journal(state)
    def request(self,url):
        row=self.j.add("http",self.net.get(url))
        if row.get("http_status") in (401,403):
            self.s["finished"]=True; self.s["halt_reason"]="PUBLIC_SOURCE_PERMISSION_DENIED"
            raise PermissionError("Public source refused access; no bypass or automatic retry")
        return row
    def discover(self):
        now=time.time(); date=datetime.fromtimestamp(now,ZoneInfo("America/New_York")).date()
        series=self.request(KALSHI+"/series/KXNHLGAME")
        self.s["series_fee"]=series.get("body",{}).get("series") if isinstance(series.get("body"),dict) else None
        markets=[]; cursor=""; complete=False
        for _ in range(5):
            query={"series_ticker":"KXNHLGAME","status":"open","limit":1000}
            if cursor: query["cursor"]=cursor
            r=self.request(KALSHI+"/markets?"+urllib.parse.urlencode(query))
            if not fresh_response(r,time.time(),10): break
            markets+=r["body"].get("markets",[]); cursor=r["body"].get("cursor","")
            if not cursor: complete=True; break
        self.s["market_discovery_complete"]=complete
        for offset in (0,1):
            row=self.request(NHL+"/score/"+str(date+timedelta(days=offset)))
            if not fresh_response(row,time.time(),10): continue
            for g in row["body"].get("games",[]):
                if g.get("gameType",2)!=self.p["eligible_game_type"]: continue
                start=epoch(g.get("startTimeUTC"))
                if start is None or start<self.s["started_at"]-6*3600 or start>self.s["entry_end_at"]: continue
                gid=str(g["id"]); event=game_key(g)
                options=[m for m in markets if m.get("event_ticker")==event]
                # Both Yes/No outcomes are represented in one canonical contract.
                chosen=sorted(options,key=lambda m:m.get("ticker",""))[:1]
                game=self.s["games"].setdefault(gid,{"id":g["id"],"game_date":g["gameDate"],"scheduled_start":start,"event_ticker":event,"first_seen_at":time.time(),"counters":{},"last_poll":0,"started_candidate_at":None,"last_candidate_at":None,"max_candidate_gap":0,"candidate_entry_boundary_observed":False,"game_final_observed":False,"official_result":None,"recent_trade_ids":{},"tape_watermark":None})
                game["schedule_state"]=g.get("gameState"); game["mapping_verified"]=len(options)==2 and bool(chosen)
                if chosen: game["market"]=chosen[0]
        self.s["last_discovery_at"]=time.time()
    def tape(self,g,now):
        ticker=g["market"]["ticker"]; lower=int((g["tape_watermark"] or now)-10); upper=int(now)
        cursor=""; rows=[]; complete=False
        for _ in range(self.p["maximum_trade_pages"]):
            query={"ticker":ticker,"limit":1000,"min_ts":lower,"max_ts":upper,"is_block_trade":"false"}
            if cursor: query["cursor"]=cursor
            r=self.request(KALSHI+"/markets/trades?"+urllib.parse.urlencode(query))
            if not fresh_response(r,time.time(),10): break
            rows+=r["body"].get("trades",[]); cursor=r["body"].get("cursor","")
            if not cursor: complete=True; break
        ids=g["recent_trade_ids"]; new=0
        for row in rows:
            stamp=epoch(row.get("created_time")); tid=row.get("trade_id")
            if tid and stamp is not None and lower<=stamp<=upper and not row.get("is_block_trade") and tid not in ids: ids[tid]=stamp; new+=1
        if complete:
            g["tape_watermark"]=upper; g["recent_trade_ids"]={k:v for k,v in ids.items() if v>=upper-10}
        if len(g["recent_trade_ids"])>20000:
            complete=False; g["recent_trade_ids"]={}; g["tape_watermark"]=None
            self.s["health"]["tape_dedup_capacity_failure"]+=1
        return {"complete":complete,"through":upper if complete else None,"new_trade_records":new,"pages_cursor_remaining":bool(cursor)}
    def observe(self,g,landing=None):
        counters=Counter(g["counters"]); now=time.time()
        landing=landing or self.request(NHL+f"/gamecenter/{g['id']}/landing")
        g["last_poll"]=landing["received_at"]; counters["landing_observations"]+=1
        if not fresh_response(landing,time.time(),10):
            counters["missing_clock_response"]+=1; g["counters"]=dict(counters); return
        body=landing["body"]; c=parse_clock(body); g["clock"]=c
        if c["live_state"] in ("OFF","FINAL"):
            g["game_final_observed"]=True
            if g.get("market"):
                official=self.request(KALSHI+"/markets/"+g["market"]["ticker"])
                m=(official.get("body") or {}).get("market",{})
                if m.get("status") in ("settled","finalized") and m.get("result") in ("yes","no"):
                    g["official_result"]={"result":m["result"],"observed_at":official["received_at"],"ticker":m.get("ticker"),"status":m["status"]}
            g["counters"]=dict(counters); return
        seconds=c["seconds_remaining"]; candidate=c["live_state"]=="LIVE" and c["period"]==3 and seconds is not None and 0<seconds<=600
        if c["live_state"]=="LIVE" and c["period"]==3 and not g.get("live_third_period_since"):
            g["live_third_period_since"]=now
        if c["live_state"]!="LIVE" or c["period"]!=3:
            g["counters"]=dict(counters); return
        if seconds is None: counters["unknown_candidate_timing"]+=1
        if seconds is not None and seconds>900:
            g["counters"]=dict(counters); return
        if not g.get("market"):
            counters["missing_market_mapping"]+=1; g["counters"]=dict(counters); return
        # Pool clock work across games; quote/tape requests remain public GET only.
        bookrow=self.request(KALSHI+f"/markets/{g['market']['ticker']}/orderbook")
        tape=self.tape(g,now); parsed=None; failures=[]
        try: parsed=parse_book(bookrow.get("body") or {})
        except (ValueError,TypeError,ArithmeticError) as exc: failures.append("invalid_book")
        if not fresh_response(bookrow,time.time(),10) or bookrow["request_seconds"]>3: failures.append("stale_or_slow_book")
        if parsed and parsed["spread"]>300: failures.append("wide_book")
        if c["source_at"] is None or not 0<=time.time()-c["source_at"]<=10: failures.append("clock_source_freshness_unverified")
        if not self.p["clock_source_semantics_verified"]: failures.append("clock_source_semantics_unverified")
        if not g["mapping_verified"]: failures.append("mapping_unverified")
        fee=self.s.get("series_fee") or {}
        if fee.get("fee_type")!="quadratic_with_maker_fees" or fee.get("fee_multiplier")!=1: failures.append("fee_unverified")
        if not tape["complete"] or time.time()-(tape["through"] or 0)>10: failures.append("tape_incomplete_or_stale")
        counters["book_observations"]+=1; counters["trade_records_observed"]+=tape["new_trade_records"]
        if candidate:
            counters["candidate_cycles_observed"]+=1
            previous=g["last_candidate_at"]
            if previous: g["max_candidate_gap"]=max(g["max_candidate_gap"],now-previous)
            else:
                g["started_candidate_at"]=now; g["candidate_entry_boundary_observed"]=seconds>=590
            g["last_candidate_at"]=now; g["last_candidate_seconds"]=seconds
            counters["valid_decision_cycles"]+=int(not failures)
            for failure in failures: counters[failure]+=1
            if not failures: g["last_valid_at"]=now
        g["counters"]=dict(counters)
        self.j.add("observation",{"game_id":g["id"],"at":now,"clock":c,"candidate":candidate,"quotes":{k:parsed[k] for k in ("yes_bid","yes_ask","no_bid","no_ask","spread")} if parsed else None,"failures":failures,"tape":tape,"strategy_scored":False,"paper_fills":None})
    def cycle(self,force=False):
        now=time.time()
        if force or now-self.s["last_discovery_at"]>=self.p["discovery_seconds"]: self.discover()
        games=[]
        for g in self.s["games"].values():
            if g["official_result"]: continue
            c=g.get("clock",{}); interval=5 if c.get("period")==3 and c.get("live_state")=="LIVE" else 30 if c.get("live_state")=="LIVE" else 60
            if force or now-g["last_poll"]>=interval: games.append(g)
        # Parallel public clock downloads, then single-threaded journal/state changes.
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            requests={pool.submit(self.net.get,NHL+f"/gamecenter/{g['id']}/landing"):g for g in games}
            for future in concurrent.futures.as_completed(requests):
                g=requests[future]; row=self.j.add("http",future.result())
                if row.get("http_status") in (401,403):
                    self.s["finished"]=True;self.s["halt_reason"]="PUBLIC_SOURCE_PERMISSION_DENIED"
                    raise PermissionError("Public clock source refused access")
                self.observe(g,row)
        self.s["last_cycle_at"]=time.time(); self.s["health"]["cycles"]+=1
        if self.s["raw_bytes"]>self.p["maximum_total_raw_bytes"]:
            self.s["halt_reason"]="RAW_DATA_BUDGET_EXCEEDED"; self.s["finished"]=True

def summarize(state):
    games=[]; qualified=0
    for g in state["games"].values():
        c=g["counters"]; observed=c.get("candidate_cycles_observed",0); valid=c.get("valid_decision_cycles",0)
        interval=(g["last_candidate_at"] or 0)-(g["started_candidate_at"] or 0)
        planned=max(observed,math.ceil(max(0,interval)/5)+1) if observed else 0
        fraction=valid/planned if planned else None
        complete=g["candidate_entry_boundary_observed"] and g.get("last_candidate_seconds",1200)<=10 and g["game_final_observed"] and g["max_candidate_gap"]<=10 and fraction is not None and fraction>=.95 and bool(g["official_result"])
        qualified+=int(complete)
        games.append({"id":g["id"],"event_ticker":g["event_ticker"],"scheduled_start":utc(g["scheduled_start"]),"clock":g.get("clock"),"counters":c,"planned_candidate_cycles":planned,"valid_decision_fraction":fraction,"max_candidate_gap_seconds":g["max_candidate_gap"],"qualified_complete_path":complete,"official_result":g["official_result"]})
    problems=[]
    for g in state["games"].values():
        c=g.get("clock",{});seconds=c.get("seconds_remaining")
        if c.get("live_state")=="LIVE" and c.get("period")==3:
            if seconds is None and time.time()-(g.get("live_third_period_since") or time.time())>300:
                problems.append({"game_id":g["id"],"kind":"UNKNOWN_CANDIDATE_TIMING_IN_LIVE_THIRD_PERIOD"})
            elif seconds is not None and 0<seconds<=600 and time.time()-(g.get("last_valid_at") or g.get("started_candidate_at") or time.time())>300:
                problems.append({"game_id":g["id"],"kind":"NO_VALID_DECISIONS_IN_ACTIVE_LATE_PERIOD"})
    return {"study_id":state["study_id"],"phase":"DATA_ONLY_NO_STRATEGY_PNL","started_at":utc(state["started_at"]),"collection_end_at":utc(state["entry_end_at"]),"as_of":utc(state["last_cycle_at"]),"raw_records":state["raw_seq"],"raw_chain_head":state["raw_hash"],"games_enrolled":len(games),"qualified_complete_game_paths":qualified,"rehearsal_status":"READY_FOR_SEPARATE_PREREG_REVIEW" if state["finished"] and qualified>=5 and not state["halt_reason"] else "INSUFFICIENT_COVERAGE" if state["finished"] else "COLLECTING_UNQUALIFIED_DATA","finished":state["finished"],"halt_reason":state["halt_reason"],"health":state["health"],"incidents":problems,"paper_pnl":None,"paper_fills":None,"venue_orders":0,"open_positions":[],"games":games}
def export(collector,work,out,segment,chunk):
    s=collector.s; out=Path(out); work=Path(work); out.mkdir(parents=True,exist_ok=True); work.mkdir(parents=True,exist_ok=True)
    s["last_cycle_at"]=time.time(); summary=summarize(s)
    with gzip.open(out/"observations.jsonl.gz","wb",compresslevel=9) as f:
        for row in collector.j.rows: f.write(row)
    for name,obj in (("state.json",s),("summary.json",summary)): (out/name).write_text(json.dumps(obj,sort_keys=True,indent=2)+"\n")
    (out/"STATUS.md").write_text(f"# NHL data rehearsal\n\nAs of {summary['as_of']}; {summary['rehearsal_status']}.\n\nNo strategy P&L or fills are scored. Orders: 0.\n\nGames enrolled: {len(s['games'])}; qualified complete paths: {summary['qualified_complete_game_paths']}.\n\nIncidents: {json.dumps(summary['incidents'])}\n")
    names=["state.json","summary.json","STATUS.md","observations.jsonl.gz"]
    manifest={"study_id":s["study_id"],"segment":segment,"chunk":chunk,"protocol_hash":s["protocol_hash"],"code_hash":s["code_hash"],"raw_previous_hash":collector.j.start_head,"raw_previous_sequence":collector.j.start_seq,"raw_records":len(collector.j.rows),"raw_head":s["raw_hash"],"files":{n:digest((out/n).read_bytes()) for n in names}}
    (out/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    verify_checkpoint(out)
    for name in names+["manifest.json"]: shutil.copyfile(out/name,work/name)
    print(json.dumps({k:summary[k] for k in ("study_id","as_of","raw_records","games_enrolled","rehearsal_status","finished","venue_orders")}))
    output=os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output,"a") as f: f.write(f"has_checkpoint=true\nfinished={str(s['finished']).lower()}\n")

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--work",required=True); ap.add_argument("--out",required=True); ap.add_argument("--seconds",type=float,default=540); ap.add_argument("--bootstrap",action="store_true"); ap.add_argument("--segment",default="bootstrap"); ap.add_argument("--chunk",default="00"); args=ap.parse_args()
    p=json.loads((ROOT/"protocol.json").read_text()); ph=digest((ROOT/"protocol.json").read_bytes()); ch=digest(Path(__file__).read_bytes()); work=Path(args.work)
    if args.bootstrap:
        if (work/"state.json").exists(): raise ValueError("bootstrap cannot overwrite existing state")
        now=time.time(); s={"study_id":p["study_id"],"protocol_hash":ph,"code_hash":ch,"run_attempt":os.environ.get("GITHUB_RUN_ATTEMPT","local"),"run_id":os.environ.get("GITHUB_RUN_ID","local"),"started_at":now,"entry_end_at":now+p["duration_hours"]*3600,"last_cycle_at":now,"last_discovery_at":0,"raw_hash":"0"*64,"raw_seq":0,"raw_bytes":0,"last_successful_http_at":None,"series_fee":None,"market_discovery_complete":False,"games":{},"health":{"http_calls":0,"http_errors":0,"cycles":0,"tape_dedup_capacity_failure":0},"finished":False,"halt_reason":None}
    else:
        s=verify_checkpoint(work)
        if s["protocol_hash"]!=ph or s["code_hash"]!=ch: raise ValueError("frozen source changed")
        if s["run_attempt"]!=os.environ.get("GITHUB_RUN_ATTEMPT","local"): raise ValueError("automatic replay/rerun forbidden")
        if s["run_id"]!=os.environ.get("GITHUB_RUN_ID","local"): raise ValueError("different run handoff forbidden")
        if s["finished"]:
            output=os.environ.get("GITHUB_OUTPUT")
            if output:
                with open(output,"a") as f: f.write("has_checkpoint=false\nfinished=true\n")
            return
    collector=Collector(p,s,Network(p)); end=min(s["entry_end_at"],time.time()+args.seconds)
    try:
        collector.cycle(force=args.bootstrap)
        if args.bootstrap and (s["health"]["http_errors"] or not s["market_discovery_complete"] or not s["games"]): raise ValueError("bootstrap public-source validation failed")
        while not args.bootstrap and time.time()<end and not STOP and not s["finished"]:
            t=time.monotonic(); collector.cycle(); time.sleep(max(0,min(5-(time.monotonic()-t),end-time.time())))
        if time.time()>=s["entry_end_at"]: s["finished"]=True
    finally: export(collector,args.work,args.out,args.segment,args.chunk)

if __name__=="__main__":
    def stop(*_):
        global STOP; STOP=True
    signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop); main()
