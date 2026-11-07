#!/usr/bin/env python3
"""MES closing-half-hour momentum (trial MES-CLOSE30-MOM-01) — implements RULES_FROZEN.md exactly.

Usage: python3 -I close30_backtest.py <BARS repo dir> <out dir>      (pandas, numpy)
"""
import glob, hashlib, json, sys
from pathlib import Path
import numpy as np
import pandas as pd

BARS, OUT = Path(sys.argv[1]), Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
PRIMARY = BARS / "ES/1min/ES_1min_2025-06-20_2026-10-09_stitched.csv"
IB_GLOB = str(BARS / "raw/ES/1min/ib/*.csv")
MULT, TICK = 5.0, 0.25
COSTS = {"C0_gross": (0, 0.0), "C1_light": (1, 2.0), "C2_primary": (2, 4.0), "C3_adverse": (3, 6.0), "C4_severe": (4, 8.0)}
PRIM = "C2_primary"
HOLIDAYS = {"2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16",
            "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07"}
EARLY = {"2025-07-03", "2025-11-28", "2025-12-24"}
# contract switch at 00:00 ET on these dates (audited; see RULES_FROZEN.md) -> contract index increments
ROLLS = ["2025-09-19", "2025-12-19", "2026-03-20", "2026-06-18", "2026-09-18"]
PERIODS = {"P1_2025-06_to_12": ("2025-06-01", "2025-12-31"), "P2_2026-01_to_10": ("2026-01-01", "2026-10-31")}
SEED, NBOOT, JUMP = 20261107, 10000, 20.0
M = lambda hhmm: (int(hhmm[:2]) * 60 + int(hhmm[3:])) - 570  # RTH minute index
I_SIG, I_ENT, I_ENT_ALT, I_EXIT, I_LAST = M("15:29"), M("15:31"), M("15:30"), M("15:59"), M("15:59")


def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load_rth(df):
    df = df.copy()
    df["dt"] = pd.to_datetime(df["datetime"], utc=True).dt.tz_convert("America/New_York")
    df = df.sort_values("dt").drop_duplicates("dt")
    mn = df["dt"].dt.hour * 60 + df["dt"].dt.minute
    r = df[(mn >= 570) & (mn <= 959)].copy()
    r["d"] = r["dt"].dt.strftime("%Y-%m-%d"); r["m"] = mn[r.index] - 570
    return r


def contract_id(d): return sum(d >= x for x in ROLLS)


def audit_sessions(r):
    rows, good = [], {}
    for d, g in r.groupby("d"):
        g = g.sort_values("m"); why = ""
        if d in HOLIDAYS: why = "holiday"
        elif d in EARLY: why = "early_close"
        elif len(g) != 390 or list(g["m"]) != list(range(390)): why = f"incomplete_{len(g)}_bars"
        else:
            o, h, l, c = (g[k].to_numpy(float) for k in ("open", "high", "low", "close"))
            if not (np.isfinite([o, h, l, c]).all() and (np.array([o, h, l, c]) > 0).all()
                    and (l <= np.minimum(o, c)).all() and (h >= np.maximum(o, c)).all() and (l <= h).all()):
                why = "invalid_ohlc"
            elif np.abs(o[1:] - c[:-1]).max() > JUMP: why = "intra_rth_discontinuity"
            elif "source" in g and g["source"].nunique() > 1: why = "mixed_source"
        rows.append({"date": d, "rth_bars": len(g), "reference_eligible": why == "", "reason": why})
        if not why: good[d] = g.reset_index(drop=True)
    return good, pd.DataFrame(rows)


def build(good):
    out, prev = [], None
    for d in sorted(good):
        g = good[d]; o, c = g["open"].to_numpy(float), g["close"].to_numpy(float)
        rec = {"date": d, "contract_idx": contract_id(d)}
        if prev is None: rec.update(status="no_prior_eligible_session")
        elif contract_id(prev[0]) != rec["contract_idx"]: rec.update(status="excluded_roll_transition", ref_date=prev[0])
        else:
            ref = prev[1]; sig = c[I_SIG]
            side = 1 if sig > ref else (-1 if sig < ref else 0)
            rec.update(ref_date=prev[0], ref_close_1559=ref, sig_close_1529=sig, signal_ret_pct=round(100 * (sig / ref - 1), 4),
                       entry_1531_open=o[I_ENT], entry_alt_1530_open=o[I_ENT_ALT], exit_1559_open=o[I_EXIT])
            if side == 0: rec.update(status="no_trade_equal")
            else:
                rec.update(status="trade", side="LONG" if side == 1 else "SHORT",
                           gross_pts=side * (o[I_EXIT] - o[I_ENT]), gross_pts_alt1530=side * (o[I_EXIT] - o[I_ENT_ALT]),
                           passive_long_pts=o[I_EXIT] - o[I_ENT])
        if "passive_long_pts" not in rec and rec.get("status") in ("no_trade_equal",):
            rec["passive_long_pts"] = o[I_EXIT] - o[I_ENT]
        out.append(rec); prev = (d, c[I_LAST])
    return pd.DataFrame(out)


def cost(pts, tk, fee): return pts * MULT - 2 * tk * TICK * MULT - fee


def stats(p, rng):
    p = np.asarray(p, float); n = len(p)
    if n == 0: return {"n": 0}
    w, lo = p[p > 0], p[p <= 0]; eq = np.cumsum(p)
    dd = float((eq - np.maximum.accumulate(np.concatenate([[0.0], eq]))[1:]).min())
    b = rng.choice(p, (NBOOT, n)).mean(1); s = np.sort(p)[::-1]
    streak = max((len(x) for x in "".join("L" if v <= 0 else "W" for v in p).split("W")), default=0)
    return {"n": n, "net": round(p.sum(), 2), "expectancy": round(p.mean(), 2), "median": round(float(np.median(p)), 2),
            "std": round(p.std(ddof=1), 2) if n > 1 else None, "win_rate": round(len(w) / n, 4),
            "avg_win": round(w.mean(), 2) if len(w) else 0.0, "avg_loss": round(lo.mean(), 2) if len(lo) else 0.0,
            "pf": round(w.sum() / -lo.sum(), 3) if lo.sum() < 0 else None, "max_dd": round(dd, 2),
            "t_stat": round(p.mean() / (p.std(ddof=1) / np.sqrt(n)), 3) if n > 1 else None,
            "boot_ci95_mean": [round(float(np.percentile(b, 2.5)), 2), round(float(np.percentile(b, 97.5)), 2)],
            "p_boot_mean_le_0": round(float((b <= 0).mean()), 4),
            "net_ex_best_trade": round(p.sum() - s[0], 2), "net_ex_best_day": round(p.sum() - s[0], 2),
            "net_ex_top3": round(p.sum() - s[:3].sum(), 2), "best": round(s[0], 2), "worst": round(s[-1], 2),
            "quantiles_5_25_50_75_95": [round(float(x), 2) for x in np.percentile(p, [5, 25, 50, 75, 95])],
            "max_consec_losses": int(streak)}


def main():
    raw = pd.read_csv(PRIMARY); r = load_rth(raw)
    good, aud = audit_sessions(r)
    sess = build(good)
    tr = sess[sess.status == "trade"].copy()
    for k, (tk, fee) in COSTS.items(): tr[f"pnl_{k}"] = cost(tr.gross_pts, tk, fee).round(2)
    tr["pnl_C2_alt_entry_1530"] = cost(tr.gross_pts_alt1530, *COSTS[PRIM]).round(2)
    tr["period"] = np.where(tr.date <= "2025-12-31", "P1", "P2")
    tr.to_csv(OUT / "trade_ledger.csv", index=False); sess.to_csv(OUT / "session_decisions.csv", index=False)
    aud.to_csv(OUT / "session_audit.csv", index=False)
    ev, dec_fail, dec_insuff = {}, [], []
    for pn, (a, b) in PERIODS.items():
        rng = np.random.default_rng(SEED)
        S = sess[(sess.date >= a) & (sess.date <= b)]; T = tr[(tr.date >= a) & (tr.date <= b)]
        sched = [d for d in pd.bdate_range(a, b).strftime("%Y-%m-%d") if d not in HOLIDAYS]
        in_data = [d for d in sched if d <= r["d"].max() and d >= r["d"].min()]
        tradable = int((S.status.isin(["trade", "no_trade_equal"])).sum())
        P = {"scheduled_sessions_full_period": len(sched), "scheduled_sessions_within_data_coverage": len(in_data),
             "reference_eligible_sessions": len(S), "trade_eligible_sessions": tradable,
             "status_counts": S.status.value_counts().to_dict(),
             "eligible_share_full_period": round(tradable / len(sched), 4),
             "eligible_share_within_coverage": round(tradable / len(in_data), 4),
             "costs": {k: stats(T[f"pnl_{k}"], rng) for k in COSTS},
             "disclosure_C2_entry_1530_open": stats(T["pnl_C2_alt_entry_1530"], rng),
             "by_side_C2": {s: stats(T[T.side == s]["pnl_C2_primary"], rng) for s in ("LONG", "SHORT")},
             "by_month_C2": T.groupby(T.date.str[:7])["pnl_C2_primary"].agg(["count", "sum", "mean"]).round(2).reset_index().to_dict("records"),
             "passive_long_C2": stats(cost(S[S.status.isin(["trade", "no_trade_equal"])].passive_long_pts, *COSTS[PRIM]), rng),
             "no_trade": {"net": 0.0}}
        ev[pn] = P; c = P["costs"][PRIM]
        if c["n"] < 50: dec_insuff.append(f"{pn}: n={c['n']} < 50")
        if P["eligible_share_full_period"] < 0.90: dec_insuff.append(f"{pn}: eligible {tradable}/{len(sched)} = {P['eligible_share_full_period']:.1%} < 90% (full-period denominator)")
        if c["n"]:
            if not c["net"] > 0: dec_fail.append(f"{pn}: C2 net {c['net']} <= 0")
            if not (c["pf"] or 0) >= 1.20: dec_fail.append(f"{pn}: C2 PF {c['pf']} < 1.20")
            if not c["boot_ci95_mean"][0] > 0: dec_fail.append(f"{pn}: C2 CI lower {c['boot_ci95_mean'][0]} <= 0")
            for k in ("net_ex_best_trade", "net_ex_best_day", "net_ex_top3"):
                if not c[k] > 0: dec_fail.append(f"{pn}: C2 {k} {c[k]} <= 0")
    verdict = "INSUFFICIENT DATA" if dec_insuff else ("PASS" if not dec_fail else "FAIL")
    # ---- data-sensitivity (non-decisional): same contract, IBKR vendor bars, 2026 overlap
    ib = pd.concat([pd.read_csv(f) for f in sorted(glob.glob(IB_GLOB))])
    cmap = {2: "ESH6", 3: "ESM6", 4: "ESU6", 5: "ESZ6"}
    xs = []
    for _, t in tr[tr.contract_idx >= 2].iterrows():
        sub = load_rth(ib[ib.contract == cmap[t.contract_idx]])
        gd = sub[sub.d == t.date].sort_values("m"); gr = sub[sub.d == t.ref_date].sort_values("m")
        if len(gd) != 390 or len(gr) != 390: continue
        sig, ref = gd.close.iloc[I_SIG], gr.close.iloc[I_LAST]
        side = 1 if sig > ref else (-1 if sig < ref else 0)
        xs.append({"date": t.date, "same_side": (side == 1) == (t.side == "LONG") and side != 0,
                   "pnl_C2_ib": cost(side * (gd.open.iloc[I_EXIT] - gd.open.iloc[I_ENT]), *COSTS[PRIM]), "pnl_C2_primary": t.pnl_C2_primary})
    X = pd.DataFrame(xs)
    xcheck = {"sessions": len(X), "same_side": int(X.same_side.sum()) if len(X) else 0,
              "C2_net_primary": round(X.pnl_C2_primary.sum(), 2) if len(X) else None,
              "C2_net_ibkr": round(X.pnl_C2_ib.sum(), 2) if len(X) else None,
              "max_abs_trade_diff": round((X.pnl_C2_ib - X.pnl_C2_primary).abs().max(), 2) if len(X) else None,
              "files": {Path(f).name: sha(f) for f in sorted(glob.glob(IB_GLOB))}}
    res = {"trial": "MES-CLOSE30-MOM-01", "data": {"file": str(PRIMARY.relative_to(BARS)), "sha256": sha(PRIMARY),
           "rth_dates": int(aud.shape[0]), "reference_eligible": int(aud.reference_eligible.sum()),
           "excluded": aud[~aud.reference_eligible].to_dict("records"), "rolls": ROLLS},
           "evaluation": ev, "decision": {"verdict": verdict, "insufficient_reasons": dec_insuff, "fail_reasons": dec_fail},
           "data_sensitivity_ibkr": xcheck}
    (OUT / "results.json").write_text(json.dumps(res, indent=1, default=float))
    print(json.dumps(res["decision"], indent=1))


if __name__ == "__main__":
    main()
