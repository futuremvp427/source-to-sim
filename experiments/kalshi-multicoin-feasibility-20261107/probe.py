#!/usr/bin/env python3
"""Read-only data-feasibility probe for Kalshi 15-minute crypto series.

Answers one question per coin: can a historical backtest be built from FREE,
PUBLIC, UNAUTHENTICATED data, with Kalshi quotes and the underlying asset on a
synchronized clock? No credentials, no order endpoints, no writes anywhere.

Output: a single JSON document on stdout (also written to --out).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
UA = "source-to-sim-feasibility-probe/1.0"

SERIES = {
    "BTC": "KXBTC15M", "ETH": "KXETH15M", "SOL": "KXSOL15M", "XRP": "KXXRP15M",
    "DOGE": "KXDOGE15M", "BNB": "KXBNB15M", "HYPE": "KXHYPE15M",
    "NEAR": "KXNEAR15M", "ZEC": "KXZEC15M",
}
MAX_MARKET_PAGES = 15  # 1000/page -> up to 15k markets (~156 days of 15m markets)

LOG: list[dict] = []


def http(method: str, url: str, body: dict | None = None, timeout: float = 20.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "User-Agent": UA, "Accept": "application/json",
        **({"Content-Type": "application/json"} if data else {}),
    })
    t0 = time.time()
    status, payload, err = None, None, None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                status = r.status
                raw = r.read()
                payload = json.loads(raw) if raw else None
            break
        except urllib.error.HTTPError as e:
            status = e.code
            err = e.read()[:300].decode("utf-8", "replace")
            if e.code == 429:
                time.sleep(2 ** attempt)
                continue
            break
        except Exception as e:  # network / decode
            err = repr(e)[:300]
            time.sleep(1 + attempt)
    LOG.append({"m": method, "url": url[:200], "status": status,
                "ms": int((time.time() - t0) * 1000), "err": err})
    time.sleep(0.12)  # stay well under Kalshi's public read limit
    return status, payload, err


def iso(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, timezone.utc).isoformat()
    return ts


def parse_ts(s):
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return int(s)
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def num(v):
    """Kalshi returns cents ints in legacy fields and dollar strings in *_dollars."""
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def list_markets(path: str, series: str):
    out, cursor, pages, last = [], None, 0, None
    while pages < MAX_MARKET_PAGES:
        q = {"series_ticker": series, "limit": 1000}
        if path == "/markets":
            q["status"] = "settled"
        if cursor:
            q["cursor"] = cursor
        st, p, err = http("GET", f"{KALSHI}{path}?{urllib.parse.urlencode(q)}")
        last = {"status": st, "err": err}
        if st != 200 or not p:
            break
        out.extend(p.get("markets") or [])
        cursor = p.get("cursor")
        pages += 1
        if not cursor:
            break
    return out, {"pages": pages, "truncated": bool(cursor) and pages >= MAX_MARKET_PAGES, "last": last}


def candle_quote(c, side):
    """Return (close_bid, close_ask) for YES from a candlestick, tolerant of schema."""
    blk = c.get(side) or {}
    if blk.get("close_dollars") is not None:
        return num(blk["close_dollars"])
    v = num(blk.get("close"))  # legacy integer cents
    return v / 100 if v is not None else None


def probe_candles(series: str, ticker: str, open_ts: int, close_ts: int, historical: bool):
    q = urllib.parse.urlencode({"start_ts": open_ts, "end_ts": close_ts, "period_interval": 1})
    path = (f"/historical/markets/{ticker}/candlesticks" if historical
            else f"/series/{series}/markets/{ticker}/candlesticks")
    st, p, err = http("GET", f"{KALSHI}{path}?{q}")
    res = {"endpoint": path.split(ticker)[0] + "{ticker}" + path.split(ticker)[1],
           "status": st, "err": err}
    if st != 200 or not p:
        return res
    cs = p.get("candlesticks") or []
    res["n_candles"] = len(cs)
    res["sample_keys"] = sorted(cs[0].keys()) if cs else []
    both, spreads = 0, []
    for c in cs:
        b, a = candle_quote(c, "yes_bid"), candle_quote(c, "yes_ask")
        if b is not None and a is not None:
            both += 1
            spreads.append(round(a - b, 4))
    res["minutes_with_bid_and_ask"] = both
    if spreads:
        res["median_spread"] = statistics.median(spreads)
        res["share_spread_le_1c"] = round(sum(s <= 0.0101 for s in spreads) / len(spreads), 3)
    if cs:
        res["sample_candle"] = cs[len(cs) // 2]
    return res


def probe_trades(ticker: str, historical: bool):
    path = "/historical/trades" if historical else "/markets/trades"
    st, p, err = http("GET", f"{KALSHI}{path}?{urllib.parse.urlencode({'ticker': ticker, 'limit': 1000})}")
    res = {"endpoint": path, "status": st, "err": err}
    if st == 200 and p:
        tr = p.get("trades") or []
        res["n_trades_first_page"] = len(tr)
        res["more_pages"] = bool(p.get("cursor"))
        res["sample_keys"] = sorted(tr[0].keys()) if tr else []
    return res


def probe_series(coin: str, series: str):
    r: dict = {"coin": coin, "series": series}
    st, p, err = http("GET", f"{KALSHI}/series/{series}")
    if st != 200 or not p:
        r["series_status"] = st
        r["series_err"] = err
        return r
    s = p.get("series", p)
    r["series_meta"] = {k: s.get(k) for k in (
        "title", "frequency", "fee_type", "fee_multiplier", "settlement_sources",
        "contract_url", "contract_terms_url", "category")}

    live, live_meta = list_markets("/markets", series)
    hist, hist_meta = list_markets("/historical/markets", series)
    r["live_settled_markets"] = {"count": len(live), **live_meta}
    r["historical_markets"] = {"count": len(hist), **hist_meta}

    def span(ms):
        ts = [parse_ts(m.get("close_time")) for m in ms if m.get("close_time")]
        return (iso(min(ts)), iso(max(ts))) if ts else (None, None)

    r["live_close_span"] = span(live)
    r["historical_close_span"] = span(hist)

    seen, merged = set(), []
    for src, ms in (("live", live), ("historical", hist)):
        for m in ms:
            t = m.get("ticker")
            if t and t not in seen:
                seen.add(t)
                merged.append((src, m))
    merged.sort(key=lambda x: parse_ts(x[1].get("close_time")) or 0)
    r["distinct_markets_total"] = len(merged)
    if merged:
        days = ((parse_ts(merged[-1][1]["close_time"]) - parse_ts(merged[0][1]["close_time"])) / 86400)
        r["distinct_span_days"] = round(days, 2)
        r["expected_markets_if_complete"] = int(days * 96)
        results = [m.get("result") for _, m in merged]
        r["result_counts"] = {k: results.count(k) for k in set(results)}
        ex = merged[-1][1]
        r["rules_primary_sample"] = (ex.get("rules_primary") or "")[:600]
        r["strike_fields_sample"] = {k: ex.get(k) for k in (
            "floor_strike", "cap_strike", "strike_type", "functional_strike",
            "expiration_value", "settlement_value", "settlement_value_dollars")}
        r["market_keys"] = sorted(ex.keys())

        # Sample candles/trades: newest, ~7 days back, ~30 days back, oldest.
        picks, now_close = [], parse_ts(merged[-1][1]["close_time"])
        for back_days in (0, 7, 30, None):
            if back_days is None:
                picks.append(merged[0])
                continue
            target = now_close - back_days * 86400
            picks.append(min(merged, key=lambda x: abs((parse_ts(x[1]["close_time"]) or 0) - target)))
        samples = []
        for src, m in picks:
            o, c = parse_ts(m.get("open_time")), parse_ts(m.get("close_time"))
            hist_flag = src == "historical"
            samples.append({
                "ticker": m.get("ticker"), "source": src, "close": iso(c),
                "volume": m.get("volume") or m.get("volume_fp"),
                "candles": probe_candles(series, m["ticker"], o, c, hist_flag),
                "trades": probe_trades(m["ticker"], hist_flag),
            })
        r["samples"] = samples
    return r


# ---------------- underlying spot data ----------------

def coinbase(coin: str, start: int):
    prod = f"{coin}-USD"
    st, p, err = http("GET", f"https://api.exchange.coinbase.com/products/{prod}")
    res = {"venue": "coinbase", "product": prod, "product_status": st}
    if st != 200:
        res["err"] = err
        return res
    q = urllib.parse.urlencode({"granularity": 60, "start": iso(start), "end": iso(start + 299 * 60)})
    st, p, err = http("GET", f"https://api.exchange.coinbase.com/products/{prod}/candles?{q}")
    res.update({"candles_status": st, "n_1m_candles_5h_window": len(p) if isinstance(p, list) else None,
                "err": err})
    return res


def binance_us(coin: str, start: int):
    out = []
    for quote in ("USD", "USDT"):
        sym = f"{coin}{quote}"
        q = urllib.parse.urlencode({"symbol": sym, "interval": "1m", "startTime": start * 1000, "limit": 300})
        st, p, err = http("GET", f"https://api.binance.us/api/v3/klines?{q}")
        out.append({"venue": "binance.us", "symbol": sym, "status": st,
                    "n_1m": len(p) if isinstance(p, list) else None, "err": err})
    return out


def binance_vision(coin: str, start: int):
    sym = f"{coin}USDT"
    q = urllib.parse.urlencode({"symbol": sym, "interval": "1m", "startTime": start * 1000, "limit": 300})
    st, p, err = http("GET", f"https://data-api.binance.vision/api/v3/klines?{q}")
    return {"venue": "binance data-api.binance.vision", "symbol": sym, "status": st,
            "n_1m": len(p) if isinstance(p, list) else None, "err": err}


def hyperliquid(coin: str, start: int):
    body = {"type": "candleSnapshot", "req": {"coin": coin, "interval": "1m",
                                              "startTime": start * 1000, "endTime": (start + 300 * 60) * 1000}}
    st, p, err = http("POST", "https://api.hyperliquid.xyz/info", body)
    return {"venue": "hyperliquid (perp)", "coin": coin, "status": st,
            "n_1m": len(p) if isinstance(p, list) else None, "err": err}


def probe_underlying(coin: str, starts: dict):
    res = {}
    for label, start in starts.items():
        row = {"coinbase": coinbase(coin, start), "binance_us": binance_us(coin, start),
               "binance_vision": binance_vision(coin, start)}
        if coin in ("HYPE", "BNB", "ZEC", "NEAR"):
            row["hyperliquid"] = hyperliquid(coin, start)
        res[label] = row
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="feasibility.json")
    ap.add_argument("--coins", default=",".join(SERIES))
    a = ap.parse_args()
    now = int(time.time())
    starts = {"7d_ago": now - 7 * 86400, "30d_ago": now - 30 * 86400, "90d_ago": now - 90 * 86400}
    report = {"generated_at": iso(now), "kalshi_base": KALSHI, "coins": {}}
    st, p, err = http("GET", f"{KALSHI}/historical/cutoff")
    report["historical_cutoff"] = {"status": st, "body": p, "err": err}
    for coin in a.coins.split(","):
        sys.stderr.write(f"probing {coin}\n")
        report["coins"][coin] = {"kalshi": probe_series(coin, SERIES[coin]),
                                 "underlying": probe_underlying(coin, starts)}
    report["request_log_summary"] = {
        "n": len(LOG),
        "non_200": [x for x in LOG if x["status"] != 200][:80],
    }
    txt = json.dumps(report, indent=1, default=str)
    with open(a.out, "w") as f:
        f.write(txt)
    print("FEASIBILITY_JSON_BEGIN")
    print(json.dumps(report, separators=(",", ":"), default=str))
    print("FEASIBILITY_JSON_END")


if __name__ == "__main__":
    main()
