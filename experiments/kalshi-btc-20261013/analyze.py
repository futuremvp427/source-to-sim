#!/usr/bin/env python3
"""Read-only evaluation of the frozen forward study; never changes strategies."""
import argparse
import gzip
import hashlib
import json
import math
import random
from pathlib import Path

from runner import UNIT, epoch, summary, Engine


def block_lower_bound(values,alpha,replications=20000):
    if len(values)<8:
        return None
    rng=random.Random(20261013)
    samples=sorted(sum(rng.choice(values) for _ in values)/len(values) for _ in range(replications))
    return samples[max(0,int(alpha*replications)-1)]


def verify_raw(path,expected_previous=None):
    count=0
    previous=expected_previous
    with gzip.open(path,"rt") as f:
        for line in f:
            row=json.loads(line)
            if previous is not None and row["previous_hash"]!=previous:
                raise ValueError("raw evidence chain discontinuity")
            canonical=json.dumps(row["record"],sort_keys=True,separators=(",",":"))
            computed=hashlib.sha256((row["previous_hash"]+canonical).encode()).hexdigest()
            if computed!=row["hash"]:
                raise ValueError("raw evidence hash mismatch")
            previous=row["hash"]
            count+=1
    return {"records":count,"chain_head":previous}


def evaluate(state,protocol,now):
    report=summary(Engine(protocol,state))
    started=state["started_at"]
    split=started+protocol["screen_hours"]*3600
    end=state["entry_end"]
    alpha=0.05/len(protocol["strategies"])
    expected=max(1,math.ceil((min(now,end)-started)/900))
    observed=len(state["observed_markets"])
    coverage=min(1,observed/expected)
    primary=[]
    for row in report["accounts"]:
        if row["contracts_requested"]!=protocol["qualification"]["primary_quantity"]:
            continue
        account=state["accounts"][row["account"]]
        completed=account["completed"]
        by_hour={}
        for meta in state["observed_markets"].values():
            t=min(meta["last_t"],epoch(meta["close_time"])-0.001)
            if split<=t<end:
                by_hour.setdefault(int((t-split)//3600),0)
        for trade in completed:
            if trade["phase"]=="holdout":
                hour=int((trade["signal_t"]-split)//3600)
                by_hour[hour]=by_hour.get(hour,0)+trade["stress_pnl_units"]/UNIT
        lower=block_lower_bound(list(by_hour.values()),alpha)
        min_n=protocol["qualification"]["min_completed_markets_each_day"]
        if now<end:
            status="IN_PROGRESS"
        elif row["open_positions"]:
            status="UNRESOLVED_SETTLEMENTS"
        elif coverage<0.9:
            status="INSUFFICIENT_COVERAGE"
        elif min(row["screen_completed"],row["holdout_completed"])<min_n:
            status="INSUFFICIENT_TRADES"
        elif row["screen_net_pnl"]<=0 or row["holdout_net_pnl"]<=0 or row["holdout_stress_net_pnl"]<=0:
            status="FAILED_SCREEN"
        elif lower is None or lower<=0:
            status="POSITIVE_BUT_UNCERTAIN"
        elif row["halted"]:
            status="FAILED_DRAWDOWN_LIMIT"
        else:
            status="PROMISING_SCREEN_ONLY"
        primary.append({**row,"status":status,"holdout_observed_hour_blocks":len(by_hour),"selection_adjusted_stressed_hourly_lower_bound":lower})
    return {"study_id":state["study_id"],"actual_venue_orders":0,"elapsed_hours":(now-started)/3600,"market_coverage_fraction":coverage,"primary_quantity":10,"family_count":len(protocol["strategies"]),"one_sided_alpha_after_bonferroni":alpha,"primary":primary,"capacity_comparisons":report["accounts"],"interpretation":"A 48-hour screen cannot establish durable profitability. Contract quantity is not independent sample size. Block-bootstrap intervals are approximate, not causal proof."}


if __name__=="__main__":
    import time
    p=argparse.ArgumentParser()
    p.add_argument("--state",required=True)
    p.add_argument("--protocol",default=str(Path(__file__).with_name("protocol.json")))
    p.add_argument("--output",required=True)
    p.add_argument("--raw")
    a=p.parse_args()
    state=json.loads(Path(a.state).read_text())
    protocol=json.loads(Path(a.protocol).read_text())
    result=evaluate(state,protocol,time.time())
    if a.raw:result["evidence_verification"]=verify_raw(a.raw)
    Path(a.output).write_text(json.dumps(result,indent=2)+"\n")
    print(json.dumps({"study_id":result["study_id"],"elapsed_hours":result["elapsed_hours"],"coverage":result["market_coverage_fraction"],"statuses":{r["strategy"]:r["status"] for r in result["primary"]}}))
