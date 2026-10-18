#!/usr/bin/env python3
"""Separate, public GET-only data soak. Never imports or starts a study collector."""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import json
import lzma
import math
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from quality import MODEL, SLUG, canonical, digest, inspect_book, readiness, resolve_catalog, transport


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect_not_permitted")


def allowed(url):
    try:
        u = urllib.parse.urlsplit(url)
        port = u.port
    except ValueError:
        return False
    if u.scheme != "https" or u.username or u.password or u.fragment or port is not None:
        return False
    if u.netloc == "gamma-api.polymarket.com":
        return u.path == "/markets" and set(urllib.parse.parse_qs(u.query)) == {"condition_ids"}
    if u.netloc != "gateway.polymarket.us":
        return False
    if u.path == "/v1/markets":
        return set(urllib.parse.parse_qs(u.query)) <= {"limit", "offset", "active", "closed", "categories", "marketTypes"}
    parts = u.path.strip("/").split("/")
    if len(parts) == 4 and parts[:3] == ["v1", "market", "slug"]:
        return bool(SLUG.fullmatch(parts[3])) and not u.query
    return len(parts) == 4 and parts[:2] == ["v1", "markets"] and bool(SLUG.fullmatch(parts[2])) and parts[3] in ("book", "bbo", "settlement") and not u.query


class Journal:
    def __init__(self, directory, evidence_limit=512 * 1024 * 1024):
        self.root = Path(directory)
        self.root.mkdir(parents=True, exist_ok=False)
        self.path = self.root / "raw.jsonl.xz"
        self.writer = lzma.open(self.path, "wb")
        self.seq, self.head, self.total, self.limit = 0, "0" * 64, 0, evidence_limit
        self.lock = threading.Lock()

    def add(self, kind, payload):
        with self.lock:
            record = {"seq": self.seq + 1, "previous_hash": self.head, "kind": kind, "payload": payload}
            encoded = canonical(record)
            if self.total + len(encoded) > self.limit:
                raise RuntimeError("evidence_limit_reached")
            head = hashlib.sha256(encoded).hexdigest()
            self.writer.write(canonical({**record, "hash": head}) + b"\n")
            self.seq, self.head = record["seq"], head
            self.total += len(encoded)
            return {"seq": self.seq, "hash": self.head}

    def close(self):
        self.writer.close()


class PublicClient:
    def __init__(self, journal, rate=3, deadline=None):
        self.journal, self.lock = journal, threading.Lock()
        self.next_at, self.cooldown_until, self.rate = 0, 0, rate
        self.deadline = deadline
        self.denied_reason = None

    def get(self, url):
        if not allowed(url):
            raise ValueError("not_public_market_data_GET")
        with self.lock:
            if self.denied_reason:
                raise PermissionError(self.denied_reason)
            tick = time.monotonic()
            wait = max(0, self.next_at - tick)
            self.next_at = max(self.next_at, tick) + 1 / self.rate
        if wait:
            time.sleep(wait)
        with self.lock:
            if self.denied_reason:
                raise PermissionError(self.denied_reason)
        if self.deadline is not None and time.time() >= self.deadline:
            raise RuntimeError("probe_time_bound_reached")
        status, data, headers, error = None, b"", {}, None
        sent = time.time()
        try:
            if sent < self.cooldown_until:
                raise ValueError("rate_limit_cooldown")
            request = urllib.request.Request(url, method="GET", headers={
                "User-Agent": "pmus-readonly-data-diagnostic/1.0", "Accept": "application/json",
                "Cache-Control": "no-cache", "Pragma": "no-cache"})
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=8) as response:
                status = response.status
                headers = dict(response.headers.items())
                data = response.read(2 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as exc:
            status, headers = exc.code, dict(exc.headers.items())
            data = exc.read(2 * 1024 * 1024 + 1)
            error = f"HTTP_{status}"
        except Exception as exc:
            error = type(exc).__name__ + ":" + str(exc)
        headers = {k.lower(): v for k, v in headers.items() if k.lower() in (
            "date", "age", "last-modified", "etag", "retry-after", "cache-control")}
        if status == 429:
            try:
                retry = min(300, max(30, float(headers.get("retry-after", 60))))
            except ValueError:
                retry = 60
            self.cooldown_until = time.time() + retry
        if len(data) > 2 * 1024 * 1024:
            error = "response_size_bound"
        if status in (401, 403):
            with self.lock:
                self.denied_reason = f"public_endpoint_access_denied_{status}"
        record = {"url": url, "method": "GET", "authenticated": False, "sent_at": sent,
                  "received_at": time.time(), "status": status, "headers": headers, "error": error,
                  "body_bytes": len(data), "body_sha256": hashlib.sha256(data).hexdigest(),
                  "raw_base64": base64.b64encode(data).decode()}
        reference = self.journal.add("http", record)
        if status in (401, 403):
            # Explicit access denial is a stop, not an invitation to bypass it.
            raise PermissionError(self.denied_reason)
        try:
            body = json.loads(data) if not error else None
        except (ValueError, UnicodeDecodeError):
            body, error = None, "non_json_response"
        return {**record, "body": body, "error": error, "evidence": reference}


def catalog(client, max_pages=50, page_size=100):
    markets, seen, evidence = [], set(), []
    for page in range(max_pages):
        query = urllib.parse.urlencode({"limit": page_size, "offset": page * page_size,
                                       "active": "true", "closed": "false", "categories": "sports",
                                       "marketTypes": "moneyline"})
        response = client.get("https://gateway.polymarket.us/v1/markets?" + query)
        evidence.append(response["evidence"])
        issues, _ = transport(response, 300)
        body = response.get("body")
        rows = body.get("markets") if isinstance(body, dict) else None
        if issues or not isinstance(rows, list):
            return {"complete": False, "markets": markets, "issues": issues or ["catalog_shape"], "evidence": evidence}
        if not rows:
            return {"complete": True, "markets": markets, "issues": [], "evidence": evidence}
        for row in rows:
            identity = row.get("id") or row.get("slug")
            if not identity or identity in seen:
                return {"complete": False, "markets": markets, "issues": ["catalog_not_advancing_or_mutated"], "evidence": evidence}
            seen.add(identity)
            markets.append(row)
    return {"complete": False, "markets": markets, "issues": ["catalog_page_bound"], "evidence": evidence}


def resolve_sources(client, conditions, listing):
    matches = {}
    if not listing["complete"]:
        return {c: {"status": "catalog_incomplete", "mapping": None,
                    "issues": listing["issues"]} for c in conditions}
    detailed = {}
    for condition in conditions:
        query = urllib.parse.urlencode({"condition_ids": condition})
        response = client.get("https://gamma-api.polymarket.com/markets?" + query)
        issues, _ = transport(response, 300)
        rows = response.get("body")
        if issues or not isinstance(rows, list) or len(rows) != 1 or rows[0].get("conditionId") != condition:
            matches[condition] = {"status": "source_metadata_unavailable", "mapping": None, "issues": issues}
        else:
            candidates = []
            for market in listing["markets"]:
                try:
                    if MODEL.stamp(market.get("gameStartTime")) != MODEL.stamp(rows[0].get("gameStartTime")):
                        continue
                except (ValueError, TypeError, AttributeError):
                    continue
                slug = market.get("slug", "")
                if not SLUG.fullmatch(slug):
                    continue
                if market.get("minimumTradeQty") is None or market.get("feeCoefficient") is None:
                    if slug not in detailed:
                        detail = client.get("https://gateway.polymarket.us/v1/market/slug/" + slug)
                        problems, _ = transport(detail, 300)
                        target = (detail.get("body") or {}).get("market")
                        detailed[slug] = target if not problems and isinstance(target, dict) and target.get("slug") == slug else None
                    market = detailed[slug]
                if market:
                    candidates.append(market)
            matches[condition] = resolve_catalog(rows[0], candidates, listing["complete"])
        matches[condition]["source_metadata_evidence"] = response["evidence"]
    return matches


def refresh_matches(client, initial, listing):
    refreshed = resolve_sources(client, list(initial), listing)
    for condition, original in initial.items():
        mapping = original.get("mapping")
        current = refreshed[condition]
        if not mapping:
            # A bootstrap miss is retained, not quietly replaced mid-soak.
            refreshed[condition] = original
        elif current.get("mapping") and current["mapping"] != mapping:
            refreshed[condition] = {"status": "mapping_drift", "mapping": None}
        elif not current.get("mapping"):
            # An official final US payout is valid terminal data, not a quote.
            response = client.get("https://gateway.polymarket.us/v1/markets/" + mapping["us_slug"] + "/settlement")
            issues, _ = transport(response)
            body = response.get("body")
            try:
                if issues or not isinstance(body, dict) or body.get("slug") != mapping["us_slug"]:
                    raise ValueError("unverified_us_settlement")
                value = MODEL.number(body["settlement"])
                if not 0 <= value <= 1:
                    raise ValueError("invalid_us_settlement")
                refreshed[condition] = {"status": "official_us_settled", "mapping": mapping,
                                        "settlement": str(value), "evidence": response["evidence"]}
            except (ValueError, KeyError, TypeError, ArithmeticError):
                pass
    return refreshed


def capture_cycle(client, matches, tick, scheduled_at):
    # Schedule all distinct markets before evaluating any. No first-error return.
    slugs = sorted({m["mapping"]["us_slug"] for m in matches.values()
                    if m.get("mapping") and m["status"] != "official_us_settled"})

    def one(slug):
        try:
            response = client.get("https://gateway.polymarket.us/v1/markets/" + slug + "/book")
            result = inspect_book(response, slug)
            result["evidence"] = response["evidence"]
            result["kind"] = "book"
            result["sample_received_at"] = response["received_at"]
            if not scheduled_at <= response["received_at"] < scheduled_at + 20:
                result["issues"].append("outside_scheduled_observation_slot")
                result["usable"] = False
            return slug, result
        except (ValueError, TypeError) as exc:
            return slug, {"slug": slug, "usable": False, "issues": [str(exc)]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = dict(pool.map(one, slugs))
    markets = {}
    for condition, match in matches.items():
        mapping = match.get("mapping")
        if match["status"] == "official_us_settled":
            markets[condition] = {"usable": True, "issues": [], "slug": mapping["us_slug"],
                                   "kind": "official_us_settlement", "settlement": match["settlement"],
                                   "evidence": match["evidence"]}
        else:
            markets[condition] = results[mapping["us_slug"]] if mapping else {
                "usable": False, "issues": [match["status"]], "slug": None}
    return {"tick": tick, "scheduled_at": scheduled_at, "finished_at": time.time(), "markets": markets}


def verify_journal(path):
    head, seq = "0" * 64, 0
    with lzma.open(path, "rt") as f:
        for line in f:
            row = json.loads(line)
            claimed = row.pop("hash")
            if row["seq"] != seq + 1 or row["previous_hash"] != head or digest(row) != claimed:
                raise ValueError("journal_linkage_mismatch")
            if row["kind"] == "http":
                h = row["payload"]
                raw = base64.b64decode(h["raw_base64"], validate=True)
                if len(raw) != h["body_bytes"] or hashlib.sha256(raw).hexdigest() != h["body_sha256"]:
                    raise ValueError("http_body_digest_mismatch")
                if h["method"] != "GET" or h["authenticated"] is not False or not allowed(h["url"]):
                    raise ValueError("unexpected_request_authority")
            seq, head = row["seq"], claimed
    return {"records": seq, "head": head, "verified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watchlist", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New, nonexistent scratch directory only")
    parser.add_argument("--run-seconds", type=int, default=60, help="60-second smoke by default; 86400 for full planned soak")
    parser.add_argument("--approved-public-watchlist-queries", action="store_true",
                        help="Only after explicit approval to disclose selected market IDs to the two public APIs")
    args = parser.parse_args()
    if not args.approved_public_watchlist_queries:
        parser.error("Live queries reveal the selected research market set to gamma-api.polymarket.com and gateway.polymarket.us; explicit approval is required first")
    if not 1 <= args.run_seconds <= 86400:
        parser.error("run-seconds must be 1..86400")
    watch = json.loads(args.watchlist.read_bytes())
    if watch.get("fixture_only"):
        parser.error("The synthetic example is offline-only; an approved real watchlist is required")
    conditions = watch["source_condition_ids"]
    if not conditions or len(conditions) > 50 or len(set(conditions)) != len(conditions):
        parser.error("watchlist must have 1..50 unique conditions")
    if not all(isinstance(x, str) and len(x) == 66 and x.startswith("0x") and all(c in "0123456789abcdef" for c in x[2:]) for x in conditions):
        parser.error("invalid condition identity")
    journal = Journal(args.output)
    client = PublicClient(journal, deadline=time.time() + 180)
    cycles, failure = [], None
    plan = {"started_at": time.time(), "planned_duration_seconds": 86400, "interval_seconds": 20,
            "watchlist_sha256": hashlib.sha256(args.watchlist.read_bytes()).hexdigest(),
            "diagnostic_code_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                       for p in (Path(__file__), Path(__file__).with_name("quality.py"))},
            "matches": {c: {"status": "bootstrap_incomplete", "mapping": None} for c in conditions}}
    try:
        listing = catalog(client)
        plan["catalog"] = {k: v for k, v in listing.items() if k != "markets"}
        plan["matches"] = resolve_sources(client, conditions, listing)
        plan["started_at"] = time.time()
        journal.add("plan", plan)
        current_matches, metadata_at = plan["matches"], time.time()
        stop = plan["started_at"] + args.run_seconds
        client.deadline = stop + 8
        tick = 0
        while time.time() < stop:
            scheduled = plan["started_at"] + tick * plan["interval_seconds"]
            delay = scheduled - time.time()
            if delay > 0:
                time.sleep(min(delay, max(0, stop - time.time())))
            if time.time() >= stop:
                break
            if time.time() - metadata_at >= 300:
                listing = catalog(client)
                current_matches = refresh_matches(client, plan["matches"], listing)
                metadata_at = time.time()
                journal.add("catalog_refresh", {"at": metadata_at, "matches": current_matches,
                                                  "complete": listing["complete"]})
            cycle = capture_cycle(client, current_matches, tick, scheduled)
            journal.add("cycle", cycle)
            cycles.append(cycle)
            # Missed ticks are NOT replaced with fast catch-up requests or dropped.
            tick = max(tick + 1, math.ceil((time.time() - plan["started_at"]) / plan["interval_seconds"]))
    except (Exception, KeyboardInterrupt) as exc:
        failure = type(exc).__name__ + ":" + str(exc)
    finally:
        journal.close()
    result = readiness(plan, cycles, time.time())
    result.update({"plan": plan, "actual_cycles": len(cycles), "failure": failure,
                   "requested_run_seconds": args.run_seconds,
                   "evidence": verify_journal(journal.path), "new_paper_trial_started": False})
    (journal.root / "summary.json").write_bytes(json.dumps(result, indent=2).encode() + b"\n")
    print(json.dumps({k: v for k, v in result.items() if k not in ("plan", "markets")}, indent=2))
    return 0 if failure is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
