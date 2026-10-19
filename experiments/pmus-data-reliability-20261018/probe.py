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

from quality import (MODEL, SLUG, canonical, digest, inspect_book, inspect_settlement,
                     metadata_deadline, readiness, resolve_catalog, transport)


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
        query = urllib.parse.parse_qs(u.query)
        return (u.path == "/markets" and "condition_ids" in query
                and set(query) <= {"condition_ids", "closed"}
                and ("closed" not in query or query["closed"] == ["any"]))
    if u.netloc != "gateway.polymarket.us":
        return False
    if u.path == "/v1/markets":
        return set(urllib.parse.parse_qs(u.query)) <= {"limit", "offset", "active", "closed", "categories", "marketTypes"}
    parts = u.path.strip("/").split("/")
    if len(parts) == 4 and parts[:3] == ["v1", "market", "slug"]:
        return bool(SLUG.fullmatch(parts[3])) and not u.query
    return len(parts) == 4 and parts[:2] == ["v1", "markets"] and bool(SLUG.fullmatch(parts[2])) and parts[3] in ("book", "bbo", "settlement") and not u.query


class Journal:
    def __init__(self, directory, evidence_limit=512 * 1024 * 1024,
                 body_limit=1024 * 1024 * 1024):
        self.root = Path(directory)
        self.root.mkdir(parents=True, exist_ok=False)
        self.path = self.root / "raw.jsonl.xz"
        self.writer = lzma.open(self.path, "wb")
        (self.root / "bodies").mkdir()
        self.body_limit, self.body_total, self.bodies = body_limit, 0, {}
        self.seq, self.head, self.total, self.limit = 0, "0" * 64, 0, evidence_limit
        self.lock = threading.RLock()

    def http(self, record, data):
        """Store exact bytes once; retain a hashed reference for EVERY request."""
        with self.lock:
            sha = hashlib.sha256(data).hexdigest()
            if sha not in self.bodies:
                compressed = lzma.compress(data, preset=3)
                if self.body_total + len(compressed) > self.body_limit:
                    raise RuntimeError("compressed_body_evidence_limit_reached")
                path = "bodies/" + sha + ".xz"
                with (self.root / path).open("xb") as f:
                    f.write(compressed)
                self.bodies[sha] = {"body_path": path, "compressed_bytes": len(compressed)}
                self.body_total += len(compressed)
            return self.add("http", {**record, **self.bodies[sha]})

    def add(self, kind, payload):
        with self.lock:
            record = {"seq": self.seq + 1, "previous_hash": self.head, "kind": kind, "payload": payload}
            encoded = canonical(record)
            head = hashlib.sha256(encoded).hexdigest()
            line = canonical({**record, "hash": head}) + b"\n"
            if self.total + len(line) > self.limit:
                raise RuntimeError("evidence_limit_reached")
            self.writer.write(line)
            self.seq, self.head = record["seq"], head
            self.total += len(line)
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
        try:
            body = json.loads(data) if not error else None
        except (ValueError, UnicodeDecodeError):
            body, error = None, "non_json_response"
        record = {"url": url, "method": "GET", "authenticated": False, "sent_at": sent,
                  "received_at": time.time(), "status": status, "headers": headers, "error": error,
                  "body_bytes": len(data), "body_sha256": hashlib.sha256(data).hexdigest()}
        reference = self.journal.http(record, data)
        if status in (401, 403):
            # Explicit access denial is a stop, not an invitation to bypass it.
            raise PermissionError(self.denied_reason)
        return {**record, "body": body, "error": error, "evidence": reference}


def catalog(client, max_pages=50, page_size=100):
    markets, seen, evidence, deadlines = [], set(), [], []
    for page in range(max_pages):
        query = urllib.parse.urlencode({"limit": page_size, "offset": page * page_size,
                                       "active": "true", "closed": "false", "categories": "sports",
                                       "marketTypes": "moneyline"})
        response = client.get("https://gateway.polymarket.us/v1/markets?" + query)
        evidence.append(response["evidence"])
        deadlines.append(metadata_deadline(response))
        issues, _ = transport(response, 300)
        body = response.get("body")
        rows = body.get("markets") if isinstance(body, dict) else None
        if issues or not isinstance(rows, list):
            return {"complete": False, "markets": markets, "issues": issues or ["catalog_shape"], "evidence": evidence}
        if not rows:
            return {"complete": True, "markets": markets, "issues": [], "evidence": evidence,
                    "valid_until": min(deadlines)}
        for row in rows:
            identity = row.get("id") or row.get("slug")
            if not identity or identity in seen:
                return {"complete": False, "markets": markets, "issues": ["catalog_not_advancing_or_mutated"], "evidence": evidence}
            seen.add(identity)
            markets.append(row)
    return {"complete": False, "markets": markets, "issues": ["catalog_page_bound"], "evidence": evidence}


def resolve_sources(client, conditions, listing):
    if not listing["complete"]:
        return {c: {"status": "catalog_incomplete", "mapping": None,
                    "issues": listing["issues"]} for c in conditions}
    detailed, detail_lock = {}, threading.Lock()

    def one(condition):
        # An identifier lookup must include closed source contracts. Their
        # identity/rules remain useful; their resolution is NOT a US settlement.
        query = urllib.parse.urlencode({"condition_ids": condition, "closed": "any"})
        response = client.get("https://gamma-api.polymarket.com/markets?" + query)
        issues, _ = transport(response, 300)
        rows = response.get("body")
        if issues or not isinstance(rows, list) or len(rows) != 1 or rows[0].get("conditionId") != condition:
            shape = "empty_source_lookup" if rows == [] else "invalid_source_lookup_identity_or_shape"
            match = {"status": "source_metadata_unavailable", "mapping": None,
                     "issues": issues or [shape]}
        else:
            candidates = []
            deadline = min(metadata_deadline(response), listing.get("valid_until", float("inf")))
            incomplete_candidates = False
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
                    with detail_lock:
                        owner = slug not in detailed
                        if owner:
                            detailed[slug] = concurrent.futures.Future()
                        future = detailed[slug]
                    if owner:
                        try:
                            detail = client.get("https://gateway.polymarket.us/v1/market/slug/" + slug)
                            problems, _ = transport(detail, 300)
                            target = (detail.get("body") or {}).get("market")
                            future.set_result((target, metadata_deadline(detail)) if not problems and isinstance(target, dict) and target.get("slug") == slug else (None, 0))
                        except BaseException as exc:
                            future.set_exception(exc)
                            raise
                    market, detail_deadline = future.result()
                    deadline = min(deadline, detail_deadline)
                    incomplete_candidates |= market is None
                if market:
                    candidates.append(market)
            match = resolve_catalog(rows[0], candidates, not incomplete_candidates)
            match["metadata_valid_until"] = deadline
            match["source_closed"] = rows[0].get("closed")
        match["source_metadata_evidence"] = response["evidence"]
        return condition, match

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        return dict(pool.map(one, conditions))


def refresh_matches(client, initial, listing):
    refreshed = resolve_sources(client, list(initial), listing)
    if not listing["complete"]:
        # A failed page is not evidence that every watched market retired.
        return refreshed
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
            terminal = inspect_settlement(client.get("https://gateway.polymarket.us/v1/markets/" + mapping["us_slug"] + "/settlement"), mapping["us_slug"])
            if terminal["usable"]:
                refreshed[condition] = {"status": "official_us_settled", "mapping": mapping,
                                        "settlement": terminal["settlement"], "evidence": terminal["evidence"]}
    return refreshed


class MetadataRefresher:
    """A slow catalog refresh must never occupy the book sampling thread."""
    def __init__(self, client, initial, journal, interval=60):
        self.client, self.initial, self.journal = client, initial, journal
        self.interval, self.next_at = interval, time.time() + interval
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.future = None

    def poll(self, current, at):
        if self.future is not None and self.future.done():
            # Permission errors and evidence failures propagate, never disappear.
            refreshed = self.future.result()
            self.future = None
            # A verified terminal payout cannot be reverted to a tradable book.
            applied = {}
            for c, m in refreshed.items():
                old = current[c]
                temporary = m["status"] in ("catalog_incomplete", "source_metadata_unavailable")
                if old["status"] == "official_us_settled":
                    applied[c] = old
                elif temporary and old.get("mapping") and at < old.get("metadata_valid_until", 0):
                    # Use only the still-valid cached proof. Never reset its
                    # expiry after a failed refresh or mask the failed request.
                    applied[c] = {**old, "last_metadata_refresh_error": m}
                else:
                    applied[c] = m
            current = applied
            self.journal.add("metadata_refresh_applied", {"at": at, "matches": current})
        if self.future is None and at >= self.next_at:
            self.next_at = at + self.interval
            self.future = self.pool.submit(self._refresh)
        return current

    def _refresh(self):
        listing = catalog(self.client)
        matches = refresh_matches(self.client, self.initial, listing)
        self.journal.add("metadata_refresh_completed", {"at": time.time(),
                         "complete": listing["complete"], "matches": matches})
        return matches

    def close(self):
        # End outstanding metadata work at the bounded stop, then join before
        # closing its shared evidence writer. Never leave a background writer.
        self.client.deadline = min(self.client.deadline or time.time(), time.time())
        self.pool.shutdown(wait=True, cancel_futures=True)
        if self.future is not None and self.future.done() and not self.future.cancelled():
            try:
                self.future.result()
            except RuntimeError as exc:
                if str(exc) != "probe_time_bound_reached":
                    raise
                self.journal.add("metadata_refresh_stopped_at_time_bound", {"at": time.time()})


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
            if (result.get("returned_slug") == slug and result.get("market_state")
                    and result["market_state"] != "MARKET_STATE_OPEN"):
                terminal = inspect_settlement(client.get("https://gateway.polymarket.us/v1/markets/" + slug + "/settlement"), slug)
                if terminal["usable"]:
                    terminal["rejected_book"] = result
                    result = terminal
                else:
                    result["settlement_check"] = terminal
            if not scheduled_at <= result["sample_received_at"] < scheduled_at + 20:
                result["issues"].append("outside_scheduled_observation_slot")
                result["usable"] = False
            return slug, result
        except (ValueError, TypeError) as exc:
            return slug, {"slug": slug, "usable": False, "issues": [str(exc)]}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = dict(pool.map(one, slugs))
    markets = {}
    for condition, match in matches.items():
        mapping = match.get("mapping")
        if match["status"] == "official_us_settled":
            markets[condition] = {"usable": True, "issues": [], "slug": mapping["us_slug"],
                                   "kind": "official_us_settlement", "settlement": match["settlement"],
                                   "evidence": match["evidence"]}
        else:
            markets[condition] = dict(results[mapping["us_slug"]]) if mapping else {
                "usable": False, "issues": [match["status"]], "slug": None}
            if mapping and markets[condition].get("sample_received_at", scheduled_at) >= match.get("metadata_valid_until", float("inf")):
                markets[condition]["issues"] = [*markets[condition]["issues"], "expired_mapping_metadata"]
                markets[condition]["usable"] = False
    return {"tick": tick, "scheduled_at": scheduled_at, "finished_at": time.time(), "markets": markets}


def remember_terminals(matches, initial, markets):
    """Never mutate the saved bootstrap plan when a final payout arrives."""
    updated = dict(matches)
    for condition, sample in markets.items():
        if sample.get("usable") and sample.get("kind") == "official_us_settlement":
            updated[condition] = {"status": "official_us_settled",
                "mapping": initial[condition]["mapping"], "settlement": sample["settlement"],
                "evidence": sample["evidence"]}
    return updated


def raw_body(path, record):
    """Read new deduplicated bodies and old inline journals without alteration."""
    if "raw_base64" in record:
        raw = base64.b64decode(record["raw_base64"], validate=True)
    else:
        expected = "bodies/" + record["body_sha256"] + ".xz"
        if record.get("body_path") != expected:
            raise ValueError("unexpected_body_path")
        root = Path(path).parent.resolve()
        body_path = root / expected
        if body_path.resolve().parent != root / "bodies" or body_path.is_symlink():
            raise ValueError("unexpected_body_path")
        if body_path.stat().st_size != record["compressed_bytes"]:
            raise ValueError("compressed_body_size_mismatch")
        with lzma.open(body_path, "rb") as f:
            raw = f.read(2 * 1024 * 1024 + 2)
    if len(raw) != record["body_bytes"] or hashlib.sha256(raw).hexdigest() != record["body_sha256"]:
        raise ValueError("http_body_digest_mismatch")
    return raw


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
                raw_body(path, h)
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
    cycles, failure, refresher = [], None, None
    bootstrap_started_at, measurement_started, stop = time.time(), False, None
    plan = {"started_at": time.time(), "planned_duration_seconds": 86400, "interval_seconds": 20,
            "watchlist_sha256": hashlib.sha256(args.watchlist.read_bytes()).hexdigest(),
            "diagnostic_code_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                       for p in (Path(__file__), Path(__file__).with_name("quality.py"))},
            "matches": {c: {"status": "bootstrap_incomplete", "mapping": None} for c in conditions}}
    try:
        listing = catalog(client)
        plan["catalog"] = {k: v for k, v in listing.items() if k != "markets"}
        plan["matches"] = resolve_sources(client, conditions, listing)
        if not listing["complete"] or not any(m.get("mapping") for m in plan["matches"].values()):
            journal.add("bootstrap_rejected", plan)
            raise RuntimeError("incomplete_catalog_or_no_verified_matches")
        plan["started_at"] = time.time()
        measurement_started = True
        journal.add("plan", plan)
        current_matches = dict(plan["matches"])
        stop = plan["started_at"] + args.run_seconds
        client.deadline = stop + 8
        refresher = MetadataRefresher(client, plan["matches"], journal)
        tick = 0
        while time.time() < stop:
            scheduled = plan["started_at"] + tick * plan["interval_seconds"]
            delay = scheduled - time.time()
            if delay > 0:
                time.sleep(min(delay, max(0, stop - time.time())))
            if time.time() >= stop:
                break
            current_matches = refresher.poll(current_matches, time.time())
            cycle = capture_cycle(client, current_matches, tick, scheduled)
            journal.add("cycle", cycle)
            cycles.append(cycle)
            current_matches = remember_terminals(current_matches, plan["matches"], cycle["markets"])
            # Missed ticks are NOT replaced with fast catch-up requests or dropped.
            tick = max(tick + 1, math.ceil((time.time() - plan["started_at"]) / plan["interval_seconds"]))
    except (Exception, KeyboardInterrupt) as exc:
        failure = type(exc).__name__ + ":" + str(exc)
    finally:
        if refresher is not None:
            try:
                refresher.close()
            except Exception as exc:
                failure = failure or type(exc).__name__ + ":" + str(exc)
        journal.close()
    finished_at = time.time()
    # Shutdown jitter is not another scheduled observation opportunity. Genuine
    # missed ticks within the requested interval still count as missing.
    evaluated_at = min(finished_at, stop) if measurement_started else plan["started_at"]
    result = readiness(plan, cycles, evaluated_at)
    if measurement_started and not any(x.get("usable") for c in cycles for x in c["markets"].values()):
        failure = failure or "no_valid_observations_in_measured_interval"
    result.update({"plan": plan, "actual_cycles": len(cycles), "failure": failure,
                   "bootstrap_completed": measurement_started,
                   "bootstrap_started_at": bootstrap_started_at,
                   "bootstrap_duration_seconds": (plan["started_at"] if measurement_started else finished_at) - bootstrap_started_at,
                   "finished_at": finished_at,
                   "requested_run_seconds": args.run_seconds,
                   "evidence": verify_journal(journal.path), "new_paper_trial_started": False})
    (journal.root / "summary.json").write_bytes(json.dumps(result, indent=2).encode() + b"\n")
    print(json.dumps({k: v for k, v in result.items() if k not in ("plan", "markets")}, indent=2))
    return 0 if failure is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
