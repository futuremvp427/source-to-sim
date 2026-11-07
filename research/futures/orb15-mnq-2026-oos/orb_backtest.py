#!/usr/bin/env python3
"""15-min ORB / 5-min confirmation / 2R target — frozen-rule OOS backtest on NQ (MNQ proxy).

Implements RULES_FROZEN.md exactly. No parameters are tuned.
Usage:  python3 -I orb_backtest.py <BARS repo dir> <out dir>
Requires pandas, numpy.
"""
import json, sys, hashlib
from pathlib import Path
import numpy as np
import pandas as pd

BARS = Path(sys.argv[1]); OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
PRIMARY = BARS / "NQ/1min/NQ_1min_2026-01-01_2026-10-08_stitched.csv"
XCHECK = BARS / "raw/NQ/1min/NQ_1min_2025-07-13_2026-07-31_tradingview.csv"  # independent source, data-sensitivity only

MULT, TICK = 2.0, 0.25           # MNQ $/pt, tick size
SCEN = {"S0_gross": (0, 0.0), "S1_light": (1, 1.50), "S2_conservative": (2, 4.00), "S3_stress": (3, 6.00)}
PRIMARY_SCEN = "S2_conservative"
HOLIDAYS = {"2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07"}
EARLY_CLOSE = set()  # none scheduled 2026-01-01..2026-10-08
PERIODS = {"P1_2026-01_to_05": ("2026-01-01", "2026-05-31"), "P2_2026-06_to_10-08": ("2026-06-01", "2026-10-08")}
SEED, NBOOT = 20261107, 10000


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load(path):
    df = pd.read_csv(path)
    df["dt"] = pd.to_datetime(df["datetime"], utc=True).dt.tz_convert("America/New_York")
    df = df.sort_values("dt").drop_duplicates("dt")
    t = df["dt"].dt
    rth = df[(t.hour * 60 + t.minute >= 570) & (t.hour * 60 + t.minute <= 959)].copy()
    rth["d"] = rth["dt"].dt.strftime("%Y-%m-%d")
    rth["m"] = rth["dt"].dt.hour * 60 + rth["dt"].dt.minute - 570  # 0..389
    return rth


def sessions(rth):
    audit, ok = [], {}
    for d, g in rth.groupby("d"):
        reason = None
        if d in HOLIDAYS: reason = "holiday"
        elif d in EARLY_CLOSE: reason = "early_close"
        elif len(g) != 390 or set(g["m"]) != set(range(390)): reason = f"incomplete_rth_{len(g)}_bars"
        elif "source" in g and g["source"].nunique() > 1: reason = "mixed_source"
        else:
            j = (g["open"].values[1:] - g["close"].values[:-1])
            if np.abs(j).max() > 100: reason = "intra_rth_discontinuity(roll?)"
        audit.append({"date": d, "rth_bars": len(g), "excluded": reason or ""})
        if reason is None: ok[d] = g.sort_values("m").reset_index(drop=True)
    return ok, pd.DataFrame(audit)


def run_session(d, g):
    o, h, l, c = (g[k].values for k in ("open", "high", "low", "close"))
    orh, orl = h[:15].max(), l[:15].min()
    base = {"date": d, "or_high": orh, "or_low": orl, "or_width": orh - orl,
            "rth_open": o[0], "rth_close": c[389]}
    # 5-min candles starting 09:45 (m=15) through 15:50 (m=380): signal close at m+4, entry at m+5
    for s in range(15, 385, 5):
        cl = c[s + 4]
        side = 1 if cl > orh else (-1 if cl < orl else 0)
        if side == 0: continue
        stop = orl if side == 1 else orh
        R = abs(cl - stop); tgt = cl + side * 2 * R
        ei = s + 5; entry = o[ei]
        ex_px = ex_why = ex_i = None
        # entry-bar open already through stop/target
        if (side == 1 and entry <= stop) or (side == -1 and entry >= stop): ex_px, ex_why, ex_i = entry, "stop_at_entry_open", ei
        elif (side == 1 and entry >= tgt) or (side == -1 and entry <= tgt): ex_px, ex_why, ex_i = entry, "target_at_entry_open", ei
        else:
            for i in range(ei, 390):
                hit_stop = l[i] <= stop if side == 1 else h[i] >= stop
                hit_tgt = h[i] >= tgt if side == 1 else l[i] <= tgt
                if hit_stop:  # stop first if both (conservative); gap-through fills at open
                    gap = (o[i] < stop) if side == 1 else (o[i] > stop)
                    ex_px = o[i] if (gap and i > ei) else stop
                    ex_why = "stop_and_target_same_bar(stop_assumed)" if hit_tgt else ("stop_gap" if gap and i > ei else "stop")
                    ex_i = i; break
                if hit_tgt: ex_px, ex_why, ex_i = tgt, "target", i; break
            if ex_px is None: ex_px, ex_why, ex_i = c[389], "time_exit_1600", 389
        mfe = (h[ei:ex_i + 1].max() - entry) if side == 1 else (entry - l[ei:ex_i + 1].min())
        mae = (entry - l[ei:ex_i + 1].min()) if side == 1 else (h[ei:ex_i + 1].max() - entry)
        hm = lambda m: f"{9 + (30 + m) // 60:02d}:{(30 + m) % 60:02d}"
        return {**base, "traded": True, "side": "LONG" if side == 1 else "SHORT",
                "signal_bar": hm(s), "signal_close": cl, "entry_time": hm(ei), "entry_px": entry,
                "stop": stop, "target": tgt, "R_pts": R, "exit_time": hm(ex_i) + (" close" if ex_why == "time_exit_1600" else ""),
                "exit_px": ex_px, "exit_reason": ex_why, "gross_pts": side * (ex_px - entry),
                "mfe_pts": mfe, "mae_pts": mae}
    return {**base, "traded": False}


def costs(gross_pts, ticks, fee):
    return gross_pts * MULT - 2 * ticks * TICK * MULT - fee


def stats(pnl, dates, rng):
    pnl = np.asarray(pnl, float); n = len(pnl)
    if n == 0: return {"n": 0}
    w, lo = pnl[pnl > 0], pnl[pnl <= 0]
    eq = np.cumsum(pnl); dd = (eq - np.maximum.accumulate(np.concatenate([[0], eq]))[1:]).min()
    boot = rng.choice(pnl, (NBOOT, n)).mean(1)
    srt = np.sort(pnl)[::-1]
    t = pnl.mean() / (pnl.std(ddof=1) / np.sqrt(n)) if n > 1 else np.nan
    return {"n": n, "net": round(pnl.sum(), 2), "expectancy": round(pnl.mean(), 2),
            "median": round(float(np.median(pnl)), 2), "win_rate": round(len(w) / n, 4),
            "avg_win": round(w.mean(), 2) if len(w) else 0, "avg_loss": round(lo.mean(), 2) if len(lo) else 0,
            "pf": round(w.sum() / -lo.sum(), 3) if lo.sum() < 0 else float("inf"),
            "max_dd": round(dd, 2), "t_stat": round(t, 3),
            "boot_ci95_mean": [round(np.percentile(boot, 2.5), 2), round(np.percentile(boot, 97.5), 2)],
            "p_boot_mean_le_0": round(float((boot <= 0).mean()), 4),
            "net_ex_best_trade": round(pnl.sum() - srt[0], 2),
            "net_ex_best_day": round(pnl.sum() - srt[0], 2),  # one trade per session => identical
            "net_ex_top3": round(pnl.sum() - srt[:3].sum(), 2),
            "best_trade": round(srt[0], 2), "worst_trade": round(srt[-1], 2),
            "max_consec_losses": int(max((len(x) for x in "".join("L" if v <= 0 else "W" for v in pnl).split("W")), default=0))}


def evaluate(results, label):
    rng = np.random.default_rng(SEED)
    out = {}
    for pname, (a, b) in PERIODS.items():
        sess = [r for r in results if a <= r["date"] <= b]
        tr = [r for r in sess if r["traded"]]
        P = {"sessions_usable": len(sess), "sessions_traded": len(tr), "scenarios": {}}
        for sn, (tk, fee) in SCEN.items():
            pnl = [costs(r["gross_pts"], tk, fee) for r in tr]
            P["scenarios"][sn] = stats(pnl, [r["date"] for r in tr], rng)
        prim = [costs(r["gross_pts"], *SCEN[PRIMARY_SCEN]) for r in tr]
        bym = pd.DataFrame({"m": [r["date"][:7] for r in tr], "p": prim}).groupby("m")["p"].agg(["count", "sum", "mean"]).round(2)
        P["by_month_S2"] = bym.reset_index().to_dict("records")
        P["exit_reasons"] = pd.Series([r["exit_reason"] for r in tr]).value_counts().to_dict()
        P["side_S2"] = {s: stats([costs(r["gross_pts"], *SCEN[PRIMARY_SCEN]) for r in tr if r["side"] == s], None, rng) for s in ("LONG", "SHORT")}
        pas = [costs(r["rth_close"] - r["rth_open"], *SCEN[PRIMARY_SCEN]) for r in sess]
        P["passive_long_rth_S2"] = stats(pas, None, rng)
        P["passive_long_rth_gross"] = stats([(r["rth_close"] - r["rth_open"]) * MULT for r in sess], None, rng)
        P["no_trade"] = {"net": 0.0}
        out[pname] = P
    return out


def decide(ev, sched):
    reasons, insuff = [], []
    for p, P in ev.items():
        s = P["scenarios"][PRIMARY_SCEN]
        if s["n"] < 50: insuff.append(f"{p}: n={s['n']} < 50")
        if P["sessions_usable"] / sched[p] < 0.90: insuff.append(f"{p}: usable sessions {P['sessions_usable']}/{sched[p]} < 90%")
        if s["n"] == 0: continue
        if not s["net"] > 0: reasons.append(f"{p}: S2 net {s['net']} <= 0")
        if not s["pf"] >= 1.20: reasons.append(f"{p}: S2 PF {s['pf']} < 1.20")
        if not s["boot_ci95_mean"][0] > 0: reasons.append(f"{p}: S2 bootstrap 95% CI lower bound {s['boot_ci95_mean'][0]} <= 0")
        for k in ("net_ex_best_trade", "net_ex_best_day", "net_ex_top3"):
            if not s[k] > 0: reasons.append(f"{p}: S2 {k} {s[k]} <= 0")
    verdict = "INSUFFICIENT DATA" if insuff else ("PASS" if not reasons else "FAIL")
    return {"verdict": verdict, "insufficient_reasons": insuff, "fail_reasons": reasons}


def main():
    rth = load(PRIMARY)
    ok, audit = sessions(rth)
    audit.to_csv(OUT / "session_audit.csv", index=False)
    results = [run_session(d, g) for d, g in sorted(ok.items())]
    # scheduled sessions = weekdays in window minus exchange holidays
    sched = {}
    for p, (a, b) in PERIODS.items():
        days = pd.bdate_range(a, b).strftime("%Y-%m-%d")
        sched[p] = sum(1 for d in days if d not in HOLIDAYS)
    trades = pd.DataFrame([r for r in results if r["traded"]])
    for sn, (tk, fee) in SCEN.items():
        trades[f"pnl_{sn}"] = costs(trades["gross_pts"], tk, fee).round(2)
    trades["period"] = np.where(trades["date"] <= "2026-05-31", "P1", "P2")
    trades.to_csv(OUT / "trades.csv", index=False)
    pd.DataFrame([r for r in results if not r["traded"]]).to_csv(OUT / "no_signal_sessions.csv", index=False)
    ev = evaluate(results, "primary")
    # completeness of entry/exit data
    comp = {"trades": len(trades), "missing_entry_px": int(trades["entry_px"].isna().sum()),
            "missing_exit_px": int(trades["exit_px"].isna().sum()),
            "all_trade_sessions_have_390_bars": True,
            "ambiguous_same_bar_stop_and_target": int((trades["exit_reason"] == "stop_and_target_same_bar(stop_assumed)").sum())}
    # data-sensitivity: same frozen rules on an independent source (TradingView NQ1!), overlap only
    xr = load(XCHECK); xr = xr[xr["d"] >= "2026-01-01"]
    xok, xaudit = sessions(xr)
    common = sorted(set(xok) & set(ok))
    xres = {d: run_session(d, xok[d]) for d in common}
    pres = {r["date"]: r for r in results}
    agree = sum(1 for d in common if xres[d]["traded"] == pres[d]["traded"] and
                (not xres[d]["traded"] or (xres[d]["side"] == pres[d]["side"] and xres[d]["exit_reason"] == pres[d]["exit_reason"])))
    s2 = lambda rs: round(sum(costs(r["gross_pts"], *SCEN[PRIMARY_SCEN]) for r in rs if r["traded"]), 2)
    xcheck = {"source": str(XCHECK.relative_to(BARS)), "sha256": sha(XCHECK), "common_sessions": len(common),
              "first": common[0] if common else None, "last": common[-1] if common else None,
              "same_side_and_exit_reason": agree,
              "S2_net_primary_on_common": s2([pres[d] for d in common]),
              "S2_net_tradingview_on_common": s2([xres[d] for d in common])}
    summary = {"data": {"primary_file": str(PRIMARY.relative_to(BARS)), "sha256": sha(PRIMARY),
                        "rth_sessions_in_file": int(audit.shape[0]), "usable_sessions": len(ok),
                        "excluded": audit[audit.excluded != ""].to_dict("records"), "scheduled_sessions": sched},
               "completeness": comp, "evaluation": ev, "decision": decide(ev, sched), "data_sensitivity_xcheck": xcheck}
    (OUT / "results.json").write_text(json.dumps(summary, indent=1, default=float))
    print(json.dumps(summary["decision"], indent=1))


if __name__ == "__main__":
    main()
