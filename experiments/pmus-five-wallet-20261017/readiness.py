#!/usr/bin/env python3
"""Bounded live readiness reads. This does not start or fund the forward study."""
import argparse
import json
import time
from pathlib import Path

from collector import Collector, query
from model import canonical, iso, number, sha
from persistence import verify_raw

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", required=True)
    args = parser.parse_args()
    p = json.loads((ROOT / "protocol.json").read_text())
    state = {"raw_hash": "0" * 64, "raw_seq": 0, "raw_uncompressed_bytes": 0,
             "http_calls": 0, "http_errors": 0, "mappings": {}}
    c = Collector(state, p, args.work)
    started = time.time()
    wallets, mappings, books = [], [], []
    for w in p["wallets"]:
        clock = int(time.time())
        data, at = c.net.get(query("https://data-api.polymarket.com/v2/trades", {
            "user": w["address"], "taker_only": "false", "limit": 100,
            "start": clock - p["startup_maximum_last_trade_age_seconds"], "end": clock}))
        rows = data["data"]
        assert rows and all(x["proxy_wallet"].lower() == w["address"].lower() for x in rows)
        wallets.append({"name": w["name"], "wallet": w["address"], "returned_rows": len(rows),
                        "has_more": data["pagination"]["has_more"],
                        "latest_returned_trade_at": iso(max(float(x["timestamp"]) for x in rows)),
                        "received_at": iso(at)})
    for condition in p["readiness_conditions"]:
        m = c.mapping(condition)
        mappings.append(m)
        try:
            b = c.current_book(m["us_slug"])
            books.append({"us_slug": m["us_slug"], "qualified": True, "book_at": iso(b["at"])})
        except ValueError as exc:
            books.append({"us_slug": m["us_slug"], "qualified": False, "reason": str(exc)})
    assert any(x["qualified"] for x in books), "No timestamp-qualified US books"
    result = {"mode": "READINESS_ONLY_NOT_FORWARD_STUDY", "started_at": iso(started),
              "ended_at": iso(time.time()), "wallets": wallets, "mappings": mappings,
              "books": books, "protocol_sha256": sha((ROOT / "protocol.json").read_bytes()),
              "http_calls": state["http_calls"], "http_errors": state["http_errors"],
              "forward_study_started": False, "follower_fills": 0, "live_orders": 0}
    c.journal.add("readiness_complete", result)
    manifest = c.journal.close_chunk()
    verify_raw(c.journal.path.read_bytes(), manifest)
    out = Path(args.work)
    (out / "readiness_results.json").write_bytes(canonical(result))
    (out / "readiness_manifest.json").write_bytes(canonical(manifest))
    print(json.dumps({"mode": result["mode"], "wallets_verified": len(wallets),
                      "mappings_verified": len(mappings), "qualified_books": sum(x["qualified"] for x in books),
                      "http_calls": state["http_calls"], "http_errors": state["http_errors"],
                      "ended_at": result["ended_at"]}, indent=2))


if __name__ == "__main__":
    main()
