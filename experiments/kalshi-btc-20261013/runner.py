#!/usr/bin/env python3
"""Credential-free forward simulator. Network access is GET-only and allowlisted.

Each strategy/quantity account is an independent counterfactual, not a combined
portfolio. Execution uses the NEXT observed book, half its visible depth, and
conservative taker fees. Coinbase is a proxy, never the settlement oracle.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import os
import random
import signal
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from pathlib import Path

UNIT = 10000
KALSHI = "https://external-api.kalshi.com/trade-api/v2"
SPOT = "https://api.exchange.coinbase.com/products/BTC-USD/ticker"
STOP = False


def utc(ts=None):
    return datetime.fromtimestamp(time.time() if ts is None else ts, timezone.utc).isoformat()


def epoch(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def units(p):
    d = Decimal(str(p)) * UNIT
    if d != d.to_integral_value():
        raise ValueError("unsupported price precision")
    return int(d)


def fee_units(price_units, quantity, multiplier=1):
    """Conservative whole-cent upper bound on the general quadratic taker fee."""
    p = Decimal(price_units) / UNIT
    dollars = Decimal("0.07") * Decimal(str(multiplier)) * quantity * p * (1-p)
    return int((dollars * 100).to_integral_value(rounding=ROUND_CEILING)) * 100


def parse_book(raw):
    ob = raw.get("orderbook_fp")
    if not isinstance(ob, dict):
        raise ValueError("missing fixed-point orderbook")
    out = {}
    for side in ("yes", "no"):
        levels = []
        seen = set()
        for p, n in ob.get(side + "_dollars", []):
            pu = units(p)
            q = Decimal(str(n))
            if not (0 < pu < UNIT) or not q.is_finite() or q < 0:
                raise ValueError("invalid book level")
            if q:
                if pu in seen:
                    raise ValueError("duplicate book price level")
                seen.add(pu)
                levels.append([pu, str(q)])
        out[side] = sorted(levels, reverse=True)
    if out["yes"] and out["no"] and out["yes"][0][0] + out["no"][0][0] >= UNIT:
        raise ValueError("crossed or locked book: no assumed pair arbitrage")
    return out


def quotes(book):
    y = book["yes"][0][0] if book["yes"] else None
    n = book["no"][0][0] if book["no"] else None
    return {"yes_bid":y, "yes_ask":UNIT-n if n is not None else None,
            "no_bid":n, "no_ask":UNIT-y if y is not None else None}


def walk_book(book, side, action, qty, multiplier, depth_fraction, limit=None):
    """IOC-style fills: unfilled remainder is canceled; sell limit is optional."""
    if side not in ("yes", "no") or action not in ("buy", "sell") or qty < 0:
        raise ValueError("invalid simulated order")
    levels = book["no" if side == "yes" else "yes"] if action == "buy" else book[side]
    result = {"qty":0, "gross_units":0, "fee_units":0, "fills":[]}
    for level_p, level_n in levels:
        price = UNIT-level_p if action == "buy" else level_p
        if limit is not None and ((action == "buy" and price > limit) or (action == "sell" and price < limit)):
            break
        available = int((Decimal(level_n)*Decimal(str(depth_fraction))).to_integral_value(rounding=ROUND_FLOOR))
        n = min(qty-result["qty"], available)
        if n <= 0:
            continue
        f = fee_units(price,n,multiplier)
        result["qty"] += n
        result["gross_units"] += n*price
        result["fee_units"] += f
        result["fills"].append({"price_units":price,"qty":n,"fee_units":f})
        if result["qty"] == qty:
            break
    return result


def past_value(rows, now, lookback, field, tolerance=10):
    target = now-lookback
    eligible = [r for r in rows if r["t"] <= target and field in r]
    if not eligible or target-eligible[-1]["t"] > tolerance:
        return None
    return eligible[-1][field]


def coverage(rows, start, end, max_gap=15, min_fraction=0.8):
    rows = [r for r in rows if start <= r["t"] <= end]
    if len(rows) < 3 or rows[0]["t"]-start > max_gap or end-rows[-1]["t"] > max_gap:
        return False
    gaps = [b["t"]-a["t"] for a,b in zip(rows,rows[1:])]
    return max(gaps,default=0) <= max_gap and rows[-1]["t"]-rows[0]["t"] >= (end-start)*min_fraction


def variance_rate(rows, now, horizon):
    x = [r for r in rows if now-horizon <= r["t"] <= now]
    if not coverage(x,now-horizon,now):
        return None
    returns = [(math.log(b["spot"]/a["spot"])**2,b["t"]-a["t"]) for a,b in zip(x,x[1:]) if b["t"]>a["t"]]
    return sum(r for r,dt in returns)/sum(dt for r,dt in returns)


def buffered_prob(rows, meta, now, cfg):
    if meta.get("basis_offset") is None or not rows or not coverage(rows,now-cfg["min_spot_history_seconds"],now):
        return None
    remaining = epoch(meta["close_time"])-now
    if remaining < 60:
        return None
    v1,v2 = variance_rate(rows,now,120),variance_rate(rows,now,600)
    if v1 is None or v2 is None or max(v1,v2) <= 0:
        return None
    # Arithmetic Brownian proxy for a future final-minute average: Var = v*(T-40).
    # The log approximation, fixed basis and volatility cushion are HYPOTHESES.
    strike = float(meta["floor_strike"])
    adjusted = rows[-1]["spot"]+meta["basis_offset"]
    uncertainty = cfg["basis_uncertainty_dollars"]
    zden = math.sqrt(max(v1,v2)*cfg["variance_multiplier"]*(remaining-40))
    cdf = lambda z: 0.5*(1+math.erf(z/math.sqrt(2)))
    py = cdf(math.log(max(1,adjusted-uncertainty)/strike)/zden)-cfg["probability_haircut"]
    pn = 1-cdf(math.log((adjusted+uncertainty)/strike)/zden)-cfg["probability_haircut"]
    return {"yes":max(0,min(1,py)),"no":max(0,min(1,pn)),"variance_rate":max(v1,v2),"basis_offset":meta["basis_offset"]}


def strategy_signal(cfg, book_history, spots, meta, now):
    if not book_history:
        return None
    r = book_history[-1]
    lo,hi = cfg["window_seconds"]
    remaining = epoch(meta["close_time"])-now
    if not lo <= remaining <= hi:
        return None
    name = cfg["id"]
    side = None
    detail = {"remaining_seconds":remaining}
    if name in ("late80_hold","late90_exit"):
        side = "yes" if r["mid"] >= 0.5 else "no"
    elif name == "momentum":
        p60,p180 = past_value(spots,now,60,"spot"),past_value(spots,now,180,"spot")
        m30 = past_value(book_history,now,30,"mid")
        if p60 is None or p180 is None or m30 is None:
            return None
        ret60,ret180 = spots[-1]["spot"]/p60-1,spots[-1]["spot"]/p180-1
        dm = r["mid"]-m30
        if ret60 >= cfg["spot_return_60s"] and ret180 > 0 and dm >= cfg["contract_move_30s"]:
            side = "yes"
        elif ret60 <= -cfg["spot_return_60s"] and ret180 < 0 and dm <= -cfg["contract_move_30s"]:
            side = "no"
        detail.update(ret60=ret60,ret180=ret180,mid_change_30s=dm)
    elif name == "panic_fade":
        m30,p30 = past_value(book_history,now,30,"mid"),past_value(spots,now,30,"spot")
        if m30 is None or p30 is None:
            return None
        dm,ret = r["mid"]-m30,spots[-1]["spot"]/p30-1
        if abs(ret) <= cfg["max_abs_spot_return_30s"] and abs(dm) >= cfg["contract_move_30s"]:
            side = "no" if dm > 0 else "yes"
        detail.update(mid_change_30s=dm,spot_return_30s=ret)
    elif name == "book_pressure":
        count = cfg["persistence_samples"]
        recent = book_history[-count:]
        m15 = past_value(book_history,now,15,"mid")
        if len(recent)<count or m15 is None or recent[-1]["t"]-recent[0]["t"]<8:
            return None
        threshold = cfg["min_abs_skew"]
        if all(x["skew"] >= threshold for x in recent) and r["mid"]-m15 >= cfg["contract_move_15s"]:
            side = "yes"
        elif all(x["skew"] <= -threshold for x in recent) and r["mid"]-m15 <= -cfg["contract_move_15s"]:
            side = "no"
        detail.update(skews=[x["skew"] for x in recent],mid_change_15s=r["mid"]-m15)
    elif name == "buffered_value":
        prob = buffered_prob(spots,meta,now,cfg)
        if prob is None:
            return None
        edges = {s:prob[s]-r[s+"_ask"]/UNIT-fee_units(r[s+"_ask"],10,meta["fee_multiplier"])/(10*UNIT) for s in ("yes","no")}
        side = max(edges,key=edges.get)
        if edges[side] < cfg["min_edge_after_fees"]:
            return None
        detail.update(probabilities=prob,estimated_net_edge=edges[side])
    if side is None:
        return None
    ask = r[side+"_ask"]
    low,high = map(units,cfg["price_range"])
    if not low <= ask <= high:
        return None
    return {"strategy":name,"side":side,"limit_units":min(high,ask+units(0.01)),"signal_ask_units":ask,"t":now,"detail":detail}


def new_state(protocol, now):
    accounts = {}
    for s in protocol["strategies"]:
        for q in protocol["quantity_tiers"]:
            aid = s["id"]+":"+str(q)
            accounts[aid] = {"strategy":s["id"],"tier":q,"cash_units":units(protocol["bankroll_dollars_per_account"]),"peak_equity_units":units(protocol["bankroll_dollars_per_account"]),"max_drawdown_units":0,"halted":False,"positions":{},"completed":[]}
    return {"study_id":protocol["study_id"],"started_at":now,"entry_end":now+protocol["duration_hours"]*3600,"seq":0,"raw_hash":"0"*64,"accounts":accounts,"markets":{},"spots":[],"histories":{},"pending":[],"issued":[],"observed_markets":{},"health":defaultdict(int)}


class Engine:
    def __init__(self, protocol, state=None, now=None):
        self.p = protocol
        self.cfg = {s["id"]:s for s in protocol["strategies"]}
        self.s = state or new_state(protocol,time.time() if now is None else now)
        self.s["health"] = defaultdict(int,self.s.get("health",{}))
        if self.s["study_id"] != protocol["study_id"]:
            raise ValueError("study mismatch")

    def fill_entry(self, order, book, now):
        meta = self.s["markets"][order["ticker"]]
        if now <= order["t"] or now-order["t"] < self.p["entry_latency_min_seconds"] or self.s["seq"] <= order["seq"]:
            return False
        if now-order["t"] > self.p["order_expiry_seconds"] or now >= epoch(meta["close_time"]):
            self.s["health"]["entry_expired"] += 1
            return True
        cfg = self.cfg[order["strategy"]]
        for aid,a in self.s["accounts"].items():
            if a["strategy"] != order["strategy"] or a["halted"] or order["ticker"] in a["positions"]:
                continue
            f = walk_book(book,order["side"],"buy",a["tier"],meta["fee_multiplier"],self.p["depth_fraction"],order["limit_units"])
            if not f["qty"]:
                self.s["health"]["entry_no_liquidity_or_price"] += 1
                continue
            total = f["gross_units"]+f["fee_units"]
            open_cost = sum(x["cost_remaining_units"] for x in a["positions"].values())
            if total > a["cash_units"] or total+open_cost > units(self.p["max_open_cost_dollars_per_account"]):
                self.s["health"]["capital_skip"] += 1
                continue
            if order["strategy"] == "buffered_value":
                estimated = order["detail"]["probabilities"][order["side"]]
                if estimated-total/(f["qty"]*UNIT) < cfg["min_edge_after_fees"]:
                    self.s["health"]["value_edge_lost_at_execution"] += 1
                    continue
            a["cash_units"] -= total
            pos = {"ticker":order["ticker"],"side":order["side"],"qty":f["qty"],"initial_qty":f["qty"],"requested_qty":a["tier"],"entry_t":now,"signal_t":order["t"],"entry_seq":self.s["seq"],"entry_average_units":f["gross_units"]/f["qty"],"entry_total_units":total,"cost_remaining_units":total,"proceeds_units":0,"fees_units":f["fee_units"],"filled_legs_contracts":f["qty"],"realized_units":0,"entry_fills":f["fills"],"exit_fills":[],"signal":order["detail"],"pending_exit":None}
            a["positions"][order["ticker"]] = pos
            self.s["health"]["paper_entries"] += 1
            self.s["health"]["partial_entries"] += int(f["qty"]<a["tier"])
        return True

    def close_piece(self,a,pos,qty,gross,fees,now,reason,fills):
        old_qty = pos["qty"]
        allocated = pos["cost_remaining_units"] if qty == old_qty else pos["cost_remaining_units"]*qty//old_qty
        net = gross-fees
        a["cash_units"] += net
        pos["cost_remaining_units"] -= allocated
        pos["proceeds_units"] += net
        pos["fees_units"] += fees
        pos["realized_units"] += net-allocated
        pos["qty"] -= qty
        if reason != "official_settlement":
            pos["filled_legs_contracts"] += qty
        pos["exit_fills"].append({"t":now,"qty":qty,"gross_units":gross,"fee_units":fees,"reason":reason,"fills":fills})
        if pos["qty"] == 0:
            pos["closed_t"] = now
            pos["exit_reason"] = reason
            pos["net_pnl_units"] = pos["proceeds_units"]-pos["entry_total_units"]
            pos["stress_pnl_units"] = pos["net_pnl_units"]-units(self.p["stress_extra_cost_dollars_per_contract_per_fill"])*pos["filled_legs_contracts"]
            pos["phase"] = "screen" if pos["signal_t"] < self.s["started_at"]+self.p["screen_hours"]*3600 else "holdout"
            a["completed"].append(pos)
            del a["positions"][pos["ticker"]]
            self.s["health"]["paper_completed"] += 1

    def process_exits(self,book,ticker,now):
        qs = quotes(book)
        meta = self.s["markets"][ticker]
        for a in self.s["accounts"].values():
            pos = a["positions"].get(ticker)
            if not pos or now >= epoch(meta["close_time"]):
                continue
            pending = pos.get("pending_exit")
            if pending and self.s["seq"]>pending["seq"] and now-pending["t"]>=self.p["entry_latency_min_seconds"]:
                f = walk_book(book,pos["side"],"sell",pos["qty"],meta["fee_multiplier"],self.p["depth_fraction"])
                if f["qty"]:
                    self.close_piece(a,pos,f["qty"],f["gross_units"],f["fee_units"],now,pending["reason"],f["fills"])
                if ticker not in a["positions"]:
                    continue
                pos["pending_exit"] = {"seq":self.s["seq"],"t":now,"reason":pending["reason"]}
                continue
            bid = qs.get(pos["side"]+"_bid")
            if bid is None or pending or self.s["seq"]<=pos["entry_seq"]:
                continue
            cfg = self.cfg[a["strategy"]]
            tp,sl = units(cfg["take_profit"]),units(cfg["stop_loss"])
            reason = "take_profit" if tp and bid >= pos["entry_average_units"]+tp else "stop_loss" if sl and bid <= pos["entry_average_units"]-sl else None
            if reason:
                pos["pending_exit"] = {"seq":self.s["seq"],"t":now,"reason":reason}

    def settle(self,market,now):
        ticker = market.get("ticker")
        if market.get("status") not in ("settled","finalized") or market.get("result") not in ("yes","no"):
            return False
        value = market.get("settlement_value_dollars")
        if value is not None and units(value) != (UNIT if market["result"]=="yes" else 0):
            self.s["health"]["nonbinary_settlement_skip"] += 1
            return False
        for a in self.s["accounts"].values():
            pos = a["positions"].get(ticker)
            if pos:
                payout = UNIT if pos["side"]==market["result"] else 0
                self.close_piece(a,pos,pos["qty"],pos["qty"]*payout,0,now,"official_settlement",[])
        if ticker in self.s["markets"]:
            self.s["markets"][ticker]["official_result"] = market["result"]
            self.s["markets"][ticker]["settlement_observed_t"] = now
        return True

    def observe(self,market,book,spot,now):
        self.s["seq"] += 1
        ticker = market["ticker"]
        self.s["markets"][ticker] = market
        if spot:
            rows = self.s["spots"]
            if not rows or now>rows[-1]["t"]:
                rows.append({"t":now,"spot":spot,"ticker":ticker})
            self.s["spots"] = [r for r in rows if r["t"]>=now-1800]
        if book is None:
            self.s["health"]["stale_or_missing_book"] += 1
            if spot is None:
                self.s["health"]["stale_spot_no_decisions"] += 1
            return
        qs = quotes(book)
        if any(v is None for v in qs.values()) or qs["yes_ask"]-qs["yes_bid"] > units(self.p["max_spread_dollars"]):
            self.s["health"]["incomplete_or_wide_book"] += 1
            return
        if spot is None:
            self.s["health"]["stale_spot_no_decisions"] += 1
            return
        self.s["health"]["valid_observations"] += 1
        self.s["observed_markets"].setdefault(ticker,{"close_time":market["close_time"],"first_t":now,"last_t":now,"samples":0})
        obs = self.s["observed_markets"][ticker]
        obs["last_t"],obs["samples"] = now,obs["samples"]+1
        yd = sum(float(n) for p,n in book["yes"][:3])
        nd = sum(float(n) for p,n in book["no"][:3])
        row = {"t":now,**qs,"mid":(qs["yes_bid"]+qs["yes_ask"])/(2*UNIT),"skew":(yd-nd)/(yd+nd) if yd+nd else 0}
        hist = self.s["histories"].setdefault(ticker,[])
        hist.append(row)
        self.s["histories"][ticker] = [r for r in hist if r["t"]>=now-300]
        retained = []
        for order in self.s["pending"]:
            if now-order["t"]>self.p["order_expiry_seconds"]:
                self.s["health"]["entry_expired"] += 1
            elif order["ticker"] != ticker or not self.fill_entry(order,book,now):
                retained.append(order)
        self.s["pending"] = retained
        self.process_exits(book,ticker,now)
        for a in self.s["accounts"].values():
            equity = a["cash_units"]
            for t,pos in a["positions"].items():
                if t==ticker:
                    f = walk_book(book,pos["side"],"sell",pos["qty"],market["fee_multiplier"],self.p["depth_fraction"])
                    pos["last_mark_units"] = f["gross_units"]-f["fee_units"]
                equity += pos.get("last_mark_units",0)
            a["peak_equity_units"] = max(a["peak_equity_units"],equity)
            a["max_drawdown_units"] = max(a["max_drawdown_units"],a["peak_equity_units"]-equity)
            if a["max_drawdown_units"] >= units(self.p["bankroll_dollars_per_account"])*self.p["max_drawdown_fraction"]:
                a["halted"] = True
        if now >= self.s["entry_end"]:
            return
        if market.get("fee_type") != "quadratic" or market.get("fee_multiplier") is None or market.get("fee_checked_t",0)<now-900:
            self.s["health"]["unsupported_or_stale_fees"] += 1
            return
        for cfg in self.p["strategies"]:
            token = ticker+":"+cfg["id"]
            if token in self.s["issued"]:
                continue
            sig = strategy_signal(cfg,self.s["histories"][ticker],self.s["spots"],market,now)
            if sig:
                sig.update(ticker=ticker,seq=self.s["seq"])
                self.s["pending"].append(sig)
                self.s["issued"].append(token)
                self.s["health"]["signals"] += 1


class Client:
    def __init__(self, raw_file, engine):
        self.raw = gzip.open(raw_file,"at",encoding="utf-8")
        self.e = engine

    def record(self,obj):
        previous = self.e.s["raw_hash"]
        canonical = json.dumps(obj,sort_keys=True,separators=(",",":"))
        digest = hashlib.sha256((previous+canonical).encode()).hexdigest()
        self.raw.write(json.dumps({"previous_hash":previous,"hash":digest,"record":obj},separators=(",",":"))+"\n")
        self.raw.flush()
        self.e.s["raw_hash"] = digest

    def get(self,url):
        parsed = urllib.parse.urlparse(url)
        allowed = parsed.scheme=="https" and (url==SPOT or parsed.netloc=="external-api.kalshi.com" and parsed.path.startswith(("/trade-api/v2/markets","/trade-api/v2/series","/trade-api/v2/events")))
        if not allowed:
            raise ValueError("network endpoint denied; orders and credentials not supported")
        started = time.time()
        try:
            request = urllib.request.Request(url,headers={"User-Agent":"credential-free-kalshi-paper-research/1.0","Cache-Control":"no-cache"},method="GET")
            with urllib.request.urlopen(request,timeout=10) as response:
                data = json.load(response)
                headers = {k:response.headers.get(k) for k in ("Date","Age","Cache-Control")}
            ended = time.time()
            self.record({"url":url,"sent_t":started,"received_t":ended,"headers":headers,"data":data})
            elapsed = ended-started
            if headers.get("Age") and float(headers["Age"]) > 5:
                elapsed = max(elapsed,99)
                self.e.s["health"]["stale_http_cache"] += 1
            if headers.get("Date"):
                server_t = parsedate_to_datetime(headers["Date"]).timestamp()
                if abs(ended-server_t)>15:
                    elapsed = max(elapsed,99)
                    self.e.s["health"]["stale_http_date"] += 1
            return data,ended,elapsed
        except Exception as exc:
            self.e.s["health"]["http_errors"] += 1
            self.record({"url":url,"sent_t":started,"received_t":time.time(),"error":type(exc).__name__,"message":str(exc)[:250]})
            raise


def basis_for(meta,spots):
    opened = epoch(meta["open_time"])
    past = [r for r in spots if opened-60<=r["t"]<opened]
    if coverage(past,opened-60,opened):
        return float(meta["floor_strike"])-statistics.mean(r["spot"] for r in past)
    return None


def atomic_json(path,data):
    path = Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp = path.with_suffix(path.suffix+".tmp")
    tmp.write_text(json.dumps(data,sort_keys=True,separators=(",",":")))
    os.replace(tmp,path)


def summary(engine):
    s,p = engine.s,engine.p
    result = {"study_id":s["study_id"],"started_at":utc(s["started_at"]),"entry_end":utc(s["entry_end"]),"updated_at":utc(),"paper_only":True,"venue_orders":0,"health":dict(s["health"]),"observed_markets":len(s["observed_markets"]),"accounts":[]}
    for aid,a in sorted(s["accounts"].items()):
        trades = a["completed"]
        net = sum(t["net_pnl_units"] for t in trades)
        spent = sum(t["entry_total_units"] for t in trades)
        row = {"account":aid,"strategy":a["strategy"],"contracts_requested":a["tier"],"completed_markets":len(trades),"contracts_filled":sum(t["initial_qty"] for t in trades),"wins":sum(t["net_pnl_units"]>0 for t in trades),"net_pnl":net/UNIT,"return_on_start_bankroll_pct":net/units(p["bankroll_dollars_per_account"])*100,"return_on_cost_pct":net/spent*100 if spent else None,"fees":sum(t["fees_units"] for t in trades)/UNIT,"stress_net_pnl":sum(t["stress_pnl_units"] for t in trades)/UNIT,"max_marked_drawdown":a["max_drawdown_units"]/UNIT,"open_positions":len(a["positions"]),"cash":a["cash_units"]/UNIT,"halted":a["halted"]}
        for phase in ("screen","holdout"):
            selected = [t for t in trades if t["phase"]==phase]
            row[phase+"_completed"] = len(selected)
            row[phase+"_net_pnl"] = sum(t["net_pnl_units"] for t in selected)/UNIT
            row[phase+"_stress_net_pnl"] = sum(t["stress_pnl_units"] for t in selected)/UNIT
        result["accounts"].append(row)
    return result


def save_outputs(engine,state_path,outdir):
    outdir = Path(outdir)
    outdir.mkdir(parents=True,exist_ok=True)
    atomic_json(state_path,engine.s)
    report = summary(engine)
    atomic_json(outdir/"summary.json",report)
    rows = report["accounts"]
    with (outdir/"scoreboard.csv").open("w",newline="") as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
    with (outdir/"trades.jsonl").open("w") as f:
        for aid,a in engine.s["accounts"].items():
            for trade in a["completed"]:
                f.write(json.dumps({"account":aid,**trade})+"\n")
    md = ["# Kalshi Bitcoin forward paper study", "", "Generated: "+report["updated_at"], "", "Paper-only. Actual venue orders: 0. No established profit claim.", "", "| Strategy | Size | Completed markets | Net after modeled fees | Open |", "|---|---:|---:|---:|---:|"]
    for r in rows:
        md.append(f"| {r['strategy']} | {r['contracts_requested']} | {r['completed_markets']} | ${r['net_pnl']:.4f} | {r['open_positions']} |")
    md.extend(["", "Valid observations: "+str(report["health"].get("valid_observations",0)),"", "Contract quantities are not independent trials. Coinbase is a proxy, not CF Benchmarks. Missing liquidity is never a fill. Each account is an independent counterfactual; do not add their profits as a realizable combined portfolio."])
    (outdir/"STATUS.md").write_text("\n".join(md)+"\n")
    return report


def run(args):
    config_path = Path(args.protocol)
    protocol = json.loads(config_path.read_text())
    protocol_hash = hashlib.sha256(config_path.read_bytes()).hexdigest()
    state_path = Path(args.state)
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    if state and state.get("protocol_hash") != protocol_hash:
        raise ValueError("frozen protocol hash mismatch")
    engine = Engine(protocol,state)
    engine.s["protocol_hash"] = protocol_hash
    code_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if state and state.get("code_hash") != code_hash:
        raise ValueError("frozen code hash mismatch; new version needs a new study")
    engine.s["code_hash"] = code_hash
    outdir = Path(args.output)
    outdir.mkdir(parents=True,exist_ok=True)
    client = Client(outdir/"observations.jsonl.gz",engine)
    segment_start = time.time()
    client.record({"type":"segment_start","study_id":engine.s["study_id"],"t":segment_start,"protocol_hash":protocol_hash,"code_hash":code_hash})
    session_end = min(segment_start+args.duration_seconds,engine.s["entry_end"]+protocol["settlement_drain_minutes"]*60)
    market_refresh=fee_refresh=settle_refresh=heartbeat=0
    current=None
    series=None
    try:
        while not STOP and time.time()<session_end:
            cycle_start=time.time()
            now=cycle_start
            try:
                if series is None or now-fee_refresh>=600:
                    d,t,elapsed=client.get(KALSHI+"/series/"+protocol["series"])
                    series=d["series"];fee_refresh=t
                if now-market_refresh>=10 or current is None or epoch(current["close_time"])<=now:
                    d,t,elapsed=client.get(KALSHI+"/markets?"+urllib.parse.urlencode({"series_ticker":protocol["series"],"status":"open","limit":20}))
                    active=[m for m in d["markets"] if epoch(m["open_time"])<=t<epoch(m["close_time"]) and m.get("market_type")=="binary" and m.get("floor_strike") is not None and units(m.get("notional_value_dollars","1"))==UNIT]
                    current=min(active,key=lambda m:epoch(m["close_time"])) if active else None
                    market_refresh=t
                    if current:
                        old=engine.s["markets"].get(current["ticker"],{})
                        current["basis_offset"]=old.get("basis_offset")
                        if current["basis_offset"] is None:
                            current["basis_offset"]=basis_for(current,engine.s["spots"])
                        if old.get("event_fees_checked"):
                            for k in ("event_fee_type","event_fee_multiplier","event_fees_checked"):
                                current[k]=old.get(k)
                        else:
                            ev,et,_=client.get(KALSHI+"/events/"+current["event_ticker"])
                            ev=ev["event"]
                            current.update(event_fee_type=ev.get("fee_type_override"),event_fee_multiplier=ev.get("fee_multiplier_override"),event_fees_checked=True)
                        current["fee_type"]=current.get("event_fee_type") or series.get("fee_type")
                        current["fee_multiplier"]=current.get("event_fee_multiplier") if current.get("event_fee_multiplier") is not None else series.get("fee_multiplier")
                        current["fee_checked_t"]=fee_refresh
                # Spot prices are sampled even between intervals for basis and volatility warm-up.
                spotdata,spot_t,spot_elapsed=client.get(SPOT)
                spot_age=spot_t-epoch(spotdata["time"])
                spot=(float(spotdata["bid"])+float(spotdata["ask"]))/2 if -2<=spot_age<=protocol["max_spot_age_seconds"] and spot_elapsed<=protocol["max_quote_request_seconds"] else None
                if current:
                    d,book_t,book_elapsed=client.get(KALSHI+"/markets/"+current["ticker"]+"/orderbook")
                    book=parse_book(d) if book_elapsed<=protocol["max_quote_request_seconds"] and book_t-spot_t<=protocol["max_spot_age_seconds"] else None
                    engine.observe(current,book,spot,book_t)
                elif spot is not None:
                    engine.s["spots"].append({"t":spot_t,"spot":spot,"ticker":None})
                    engine.s["spots"]=[r for r in engine.s["spots"] if r["t"]>=spot_t-1800]
                    engine.s["health"]["no_active_market"]+=1
                if now-settle_refresh>=30:
                    pending={t for a in engine.s["accounts"].values() for t in a["positions"] if epoch(engine.s["markets"][t]["close_time"])<=time.time()}
                    for ticker in sorted(pending)[:10]:
                        d,t,elapsed=client.get(KALSHI+"/markets/"+ticker)
                        client.record({"type":"settlement_check","ticker":ticker,"t":t,"settled":engine.settle(d["market"],t)})
                    settle_refresh=time.time()
            except Exception as exc:
                engine.s["health"]["cycle_errors"]+=1
                print(json.dumps({"type":"cycle_error","t":utc(),"error":type(exc).__name__,"message":str(exc)[:200]}),flush=True)
            if time.time()-heartbeat>=60:
                report=save_outputs(engine,state_path,outdir)
                print(json.dumps({"type":"heartbeat","t":utc(),"study_start":report["started_at"],"end":report["entry_end"],"valid_samples":engine.s["health"].get("valid_observations",0),"signals":engine.s["health"].get("signals",0),"paper_entries":engine.s["health"].get("paper_entries",0),"completed":engine.s["health"].get("paper_completed",0),"errors":engine.s["health"].get("cycle_errors",0),"venue_orders":0}),flush=True)
                heartbeat=time.time()
            if time.time()>=engine.s["entry_end"] and not any(a["positions"] for a in engine.s["accounts"].values()):
                break
            delay=max(0,min(protocol["poll_seconds"]-(time.time()-cycle_start),session_end-time.time()))
            if delay:
                time.sleep(delay)
    finally:
        client.record({"type":"segment_end","t":time.time(),"stop_requested":STOP})
        client.raw.close()
        report=save_outputs(engine,state_path,outdir)
        atomic_json(outdir/"manifest.json",{"study_id":engine.s["study_id"],"protocol_hash":protocol_hash,"code_hash":code_hash,"raw_chain_head":engine.s["raw_hash"],"files":{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in outdir.iterdir() if p.is_file() and p.name!="manifest.json"}})
        print(json.dumps(report),flush=True)
    if args.require_valid_samples and engine.s["health"].get("valid_observations",0)<args.require_valid_samples:
        return 2
    return 0


def stop_handler(signum,frame):
    global STOP
    STOP=True


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--protocol",default=str(Path(__file__).with_name("protocol.json")))
    parser.add_argument("--state",default="paper-state/state.json")
    parser.add_argument("--output",default="paper-output")
    parser.add_argument("--duration-seconds",type=int,default=120)
    parser.add_argument("--require-valid-samples",type=int,default=0)
    args=parser.parse_args()
    for s in (signal.SIGINT,signal.SIGTERM):signal.signal(s,stop_handler)
    raise SystemExit(run(args))
