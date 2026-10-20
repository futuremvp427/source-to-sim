#!/usr/bin/env python3
"""Bounded, resumable data-only reliability check. No orders or source copying."""
from __future__ import annotations

import argparse
import collections
import concurrent.futures
import json
import math
import os
import threading
import time
from pathlib import Path

from durable import DurableJournal, atomic_write
from publication import GitMirror, PublicationError
from probe import PublicClient, catalog
from quality import (MODEL, canonical, digest, inspect_book, inspect_settlement,
                     metadata_deadline, transport, compare_stream, SLUG)
from stream_smoke import (StreamState, auth_headers, connect_market_stream,
                          read_stream, safe_error, select_markets, subscription)

INTERVAL = 20


class BackgroundMirror:
    """A slow GitHub save cannot consume scheduled market observation slots."""
    def __init__(self, mirror, journal):
        self.mirror, self.journal = mirror, journal
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self.future, self.errors = None, 0

    def poll(self):
        if self.future is not None and self.future.done():
            try:
                self.future.result()
            except PublicationError:
                self.errors += 1
                self.mirror.save()
                self.journal.add("publication_delayed", {"at": time.time(), "checkpoint": self.journal.checkpoint})
            self.future = None

    def submit(self):
        self.poll()
        if self.future is None:
            self.future = self.pool.submit(self.mirror.sync, self.journal)

    def close(self):
        try:
            if self.future is not None:
                concurrent.futures.wait([self.future])
                self.poll()
            # Include the final seal after any older in-flight generation.
            try:
                self.mirror.sync(self.journal)
            except PublicationError:
                self.errors += 1
                self.mirror.save()
        finally:
            self.pool.shutdown(wait=True)


class RetryClient:
    """Retry only transient transport/5xx. Preserve every attempt in raw evidence."""
    def __init__(self, client, stop):
        self.client, self.stop = client, stop

    def get(self, url):
        for attempt in range(3):
            row = self.client.get(url)
            if row["status"] not in (None, 408, 500, 502, 503, 504):
                return row
            if attempt < 2:
                self.stop.wait(2**attempt)
        return row


class ReconnectingStream:
    """Reconnect with backoff; a new session cannot reuse its predecessor's book."""
    def __init__(self, slugs, journal, stop):
        self.slugs, self.journal, self.stop = slugs, journal, stop
        self.state = StreamState(slugs, journal)
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.fatal = None
        self.connection = None

    def start(self):
        # Presence/format is checked before starting a network thread.
        auth_headers(os.environ.get("PMUS_DATA_KEY_ID", "").strip(),
                     os.environ.get("PMUS_DATA_SECRET_KEY", "").strip())
        self.worker.start()

    def run(self):
        failures = 0
        while not self.stop.is_set():
            local_stop = threading.Event()
            receiver = None
            try:
                headers = auth_headers(os.environ.get("PMUS_DATA_KEY_ID", "").strip(),
                                       os.environ.get("PMUS_DATA_SECRET_KEY", "").strip())
                conn = connect_market_stream(headers)
                self.connection = conn
                with self.state.lock:
                    self.state.latest.clear()
                    self.state.last_transport_at = None
                    self.state.failure = None
                    self.state.connected = True
                self.journal.add("stream_connected", {"at": time.time()})
                conn.send(json.dumps(subscription(self.slugs)))
                receiver = threading.Thread(target=read_stream, args=(conn, self.state, local_stop), daemon=True)
                receiver.start()
                connected_at = time.time()
                while not self.stop.wait(1) and not self.state.failure:
                    last = self.state.last_transport_at or connected_at
                    if time.time() - last > 30:
                        self.state.failure = "stream_transport_timeout"
                        break
                if time.time() - connected_at >= 60:
                    failures = 0
                reason = self.state.failure or "bounded_shutdown"
            except Exception as exc:
                reason = safe_error(exc)
            finally:
                with self.state.lock:
                    self.state.connected = False
                local_stop.set()
                if self.connection is not None:
                    try:
                        self.connection.close(timeout=1)
                    except Exception:
                        pass
                    self.connection = None
                if receiver is not None:
                    receiver.join(timeout=3)
                    if receiver.is_alive():
                        self.fatal = "stream_reader_shutdown_failed"
            self.journal.add("stream_disconnected", {"at": time.time(), "reason": reason})
            if reason.startswith("authentication_denied") or reason in ("redirect_refused", "subscription_error"):
                self.fatal = reason
            if self.fatal or self.stop.is_set():
                break
            failures += 1
            delay = min(2**min(failures, 5), 30)
            self.journal.add("stream_reconnect_wait", {"at": time.time(), "seconds": delay})
            self.stop.wait(delay)

    def close(self):
        self.stop.set()
        if self.worker.ident is not None:
            self.worker.join(timeout=15)
            if self.worker.is_alive():
                raise RuntimeError("stream_supervisor_shutdown_failed")


def market_identity(meta):
    return digest({"slug": meta["slug"], "start": meta["gameStartTime"],
                   "rules": meta["description"], "category": meta["category"],
                   "marketType": meta["marketType"],
                   "sides": [{k: side[k] for k in ("id", "long", "description")}
                             for side in meta["marketSides"]]})


def observe(client, slug, identity, stream, scheduled, terminal=None):
    """One market's failure never prevents another market's scheduled read."""
    if terminal is not None:
        return terminal
    # Refresh identity independently of book state. A stale OPEN book must not
    # hide an already resolved market, and old rules may not validate a quote.
    meta_response = client.get("https://gateway.polymarket.us/v1/market/slug/" + slug)
    metadata_issues, _ = transport(meta_response, 300)
    meta = (meta_response.get("body") or {}).get("market", {})
    try:
        identity_ok = market_identity(meta) == identity
    except (ValueError, KeyError, TypeError):
        identity_ok = False
    if not identity_ok:
        metadata_issues.append("market_identity_or_rules_changed")
    if not metadata_issues and meta.get("closed") is True and meta.get("status") == "MARKET_STATUS_RESOLVED":
        payout = inspect_settlement(client.get("https://gateway.polymarket.us/v1/markets/" + slug + "/settlement"), slug)
        long_side = next(side for side in meta["marketSides"] if side["long"])
        if (payout["usable"] and MODEL.number(payout["settlement"]) == MODEL.number(long_side["price"])
                and scheduled <= payout["sample_received_at"] < scheduled + INTERVAL):
            return {"kind": "official_us_settlement", "usable": True, "slug": slug,
                    "settlement": payout["settlement"], "evidence": payout["evidence"],
                    "metadata_evidence": meta_response["evidence"], "issues": [],
                    "verified_at": payout["sample_received_at"]}
        return {"kind": "unresolved_settlement", "usable": False, "slug": slug,
                "issues": ["official_settlement_unavailable_disagrees_or_late"],
                "settlement_check": payout}
    if not MODEL.valid_open_market(meta):
        metadata_issues.append("market_not_open")
    response = client.get("https://gateway.polymarket.us/v1/markets/" + slug + "/book")
    rest = inspect_book(response, slug)
    rest.update(evidence=response["evidence"], sample_received_at=response["received_at"])
    at = time.time()
    ws = stream.state.snapshot(slug, at) if stream else {"usable": False, "issues": ["stream_not_enabled"]}
    in_slot = scheduled <= response["received_at"] < scheduled + INTERVAL
    issues = list(metadata_issues)
    if not in_slot:
        issues.append("outside_scheduled_observation_slot")
    if not rest["usable"] and not ws["usable"]:
        issues.append("no_fresh_executable_book")
    return {"kind": "book", "slug": slug, "usable": not issues,
            "issues": issues, "rest": rest, "stream": ws,
            "metadata_evidence": meta_response["evidence"],
            "comparison": compare_stream(rest, ws),
            "http_latency_seconds": response["received_at"] - response["sent_at"]}


def summarize(plan, rows, now):
    duration, start = plan["duration_seconds"], plan["started_at"]
    planned = math.ceil(duration / INTERVAL)
    expected = min(planned, max(0, math.ceil((now - start) / INTERVAL)))
    cycles = {}
    for row in rows:
        if row["kind"] != "cycle":
            continue
        value = row["payload"]
        tick = value["tick"]
        if type(tick) is not int or not 0 <= tick < planned or tick in cycles:
            raise ValueError("duplicate_or_invalid_tick")
        cycles[tick] = value
    markets = {}
    for slug in plan["markets"]:
        counts = collections.Counter()
        problems = collections.Counter()
        for tick in range(expected):
            sample = cycles.get(tick, {}).get("markets", {}).get(slug)
            if not sample:
                problems["missing_scheduled_observation"] += 1
                continue
            counts["valid_ticks"] += bool(sample.get("usable"))
            counts["settlement_ticks"] += sample.get("kind") == "official_us_settlement" and sample.get("usable", False)
            counts["fresh_rest_ticks"] += sample.get("rest", {}).get("usable", False) and sample.get("usable", False)
            counts["fresh_stream_ticks"] += sample.get("stream", {}).get("usable", False) and sample.get("usable", False)
            counts["matched_fresh_pairs"] += sample.get("comparison", {}).get("matched", False)
            problems.update(sample.get("issues", []))
            problems.update("rest:" + x for x in sample.get("rest", {}).get("issues", []))
            problems.update("stream:" + x for x in sample.get("stream", {}).get("issues", []))
        markets[slug] = {**counts, "expected_elapsed_ticks": expected, "planned_ticks": planned,
                         "coverage_elapsed": counts["valid_ticks"] / expected if expected else 0,
                         "coverage_full_planned": counts["valid_ticks"] / planned,
                         "problems": dict(problems)}
    complete = now >= start + duration
    public_pass = bool(markets) and all(m.get("fresh_rest_ticks", 0) > 0 for m in markets.values())
    passed = (duration >= 86400 and complete and bool(markets)
              and all(m["coverage_full_planned"] >= .95 and m.get("matched_fresh_pairs", 0) > 0
                      and m.get("fresh_stream_ticks", 0) >= 30 for m in markets.values()))
    return {"schema": 1, "run_id": plan["run_id"], "code_sha": plan["code_sha"],
            "started_at": start, "evaluated_at": now, "planned_end": start + duration,
            "actual_elapsed_seconds": max(0, now - start), "completed_full_window": complete,
            "data_gate_passed": passed, "public_preflight_passed": public_pass,
            "actual_cycles": len(cycles), "markets": markets,
            "ready_for_new_paper_study": False, "actual_in_play_phase_certified": False,
            "source_wallet_coverage_evaluated": False, "orders_or_private_account_requests": 0}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--watch-plan", type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--code-sha", required=True)
    parser.add_argument("--duration-seconds", type=int, default=120)
    parser.add_argument("--segment-seconds", type=int, default=120)
    parser.add_argument("--stream", action="store_true")
    parser.add_argument("--mirror", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--initialize", action="store_true", help="Only the first segment may establish a new epoch")
    parser.add_argument("--approved-data-only", action="store_true")
    args = parser.parse_args(argv)
    if not args.approved_data_only or not 20 <= args.duration_seconds <= 86400 or not 20 <= args.segment_seconds <= 14400:
        parser.error("explicit_data_only_authorization_and_bounds_required")
    stop, stream, mirror, journal, background = threading.Event(), None, None, None, None
    failure, publication_errors = None, 0
    try:
        if args.resume:
            args.output.mkdir(parents=True, exist_ok=True)
            if args.mirror:
                mirror = GitMirror(args.run_id, args.code_sha, args.output)
                try:
                    mirror.restore()
                except PublicationError:
                    # A valid local backup outranks an unavailable remote read.
                    # With no backup, stop instead of quietly resetting the clock.
                    if not (args.output / "events.jsonl").exists() or not (args.output / "plan.json").exists():
                        raise
                    publication_errors += 1
        journal = DurableJournal(args.output, resume=args.resume)
        if args.mirror and mirror is None:
            mirror = GitMirror(args.run_id, args.code_sha, args.output)
        base_client = PublicClient(journal, deadline=time.time() + 180)
        client = RetryClient(base_client, stop)
        plan_path = args.output / "plan.json"
        if plan_path.exists():
            plan = json.loads(plan_path.read_bytes())
            if (plan["run_id"] != args.run_id or plan["code_sha"] != args.code_sha
                    or plan["duration_seconds"] != args.duration_seconds or plan["stream_enabled"] != args.stream):
                raise ValueError("resume_plan_identity_mismatch")
        else:
            if args.resume and not args.initialize:
                raise ValueError("missing_prior_plan_refuse_restart")
            if args.watch_plan:
                markets = json.loads(args.watch_plan.read_bytes())["markets"]
            else:
                listing = catalog(client)
                slugs = select_markets(listing, time.time())
                markets = {}
                for slug in slugs:
                    response = client.get("https://gateway.polymarket.us/v1/market/slug/" + slug)
                    issues, _ = transport(response, 300)
                    meta = (response.get("body") or {}).get("market", {})
                    if issues or not MODEL.valid_open_market(meta):
                        raise ValueError("unqualified_bootstrap_metadata")
                    markets[slug] = {"identity": market_identity(meta), "start_at": MODEL.stamp(meta["gameStartTime"])}
            plan = {"run_id": args.run_id, "code_sha": args.code_sha,
                    "duration_seconds": args.duration_seconds, "stream_enabled": args.stream,
                    "interval_seconds": INTERVAL, "markets": markets, "started_at": time.time()}
            atomic_write(plan_path, canonical(plan) + b"\n", immutable=True)
            journal.add("plan", plan)
        if not 1 <= len(plan["markets"]) <= 3:
            raise ValueError("invalid_bounded_watch_plan")
        if not all(SLUG.fullmatch(slug) and len(item["identity"]) == 64
                   for slug, item in plan["markets"].items()):
            raise ValueError("invalid_bounded_watch_plan")
        if mirror:
            background = BackgroundMirror(mirror, journal)
        if args.stream:
            stream = ReconnectingStream(list(plan["markets"]), journal, stop)
            stream.start()
        end = min(plan["started_at"] + args.duration_seconds, time.time() + args.segment_seconds)
        base_client.deadline = end + 8
        terminals = {}
        for row in journal.rows:
            if row["kind"] == "cycle":
                for slug, sample in row["payload"]["markets"].items():
                    if sample.get("usable") and sample.get("kind") == "official_us_settlement":
                        terminals[slug] = sample
        prior_ticks = [r["payload"]["tick"] for r in journal.rows if r["kind"] == "cycle"]
        tick = max((max(prior_ticks) + 1) if prior_ticks else 0,
                   max(0, math.ceil((time.time() - plan["started_at"]) / INTERVAL)))
        # A new plan's first observation is tick zero, not an invented missed slot.
        if not prior_ticks and time.time() - plan["started_at"] < 1:
            tick = 0
        journal.add("segment_started", {"at": time.time(), "next_tick": tick})
        next_save = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            while time.time() < end:
                scheduled = plan["started_at"] + tick * INTERVAL
                stop.wait(min(max(0, scheduled - time.time()), max(0, end - time.time())))
                if time.time() >= end:
                    break
                if stream and stream.fatal:
                    raise PermissionError(stream.fatal)
                if background:
                    background.poll()
                    publication_errors = background.errors
                futures = {slug: pool.submit(observe, client, slug, item["identity"], stream, scheduled, terminals.get(slug))
                           for slug, item in plan["markets"].items()}
                samples = {}
                for slug, future in futures.items():
                    try:
                        sample = future.result()
                    except PermissionError:
                        raise
                    except Exception as exc:
                        sample = {"slug": slug, "usable": False, "issues": [type(exc).__name__]}
                    samples[slug] = sample
                    if sample.get("kind") == "official_us_settlement" and sample.get("usable"):
                        terminals[slug] = sample
                journal.add("cycle", {"tick": tick, "scheduled_at": scheduled, "finished_at": time.time(), "markets": samples})
                if time.time() >= next_save:
                    result = summarize(plan, journal.rows, min(time.time(), plan["started_at"] + args.duration_seconds))
                    result["publication_errors"] = publication_errors
                    journal.seal(result)
                    if background:
                        background.submit()
                    next_save = time.time() + 600
                tick = max(tick + 1, math.ceil((time.time() - plan["started_at"]) / INTERVAL))
    except Exception as exc:
        known = {"missing_key_id", "missing_secret_key", "invalid_key_id_format", "invalid_secret_key_format"}
        failure = str(exc) if str(exc) in known or isinstance(exc, PermissionError) else type(exc).__name__
    finally:
        if stream is not None:
            try:
                stream.close()
            except Exception:
                failure = failure or "stream_shutdown_failed"
        stop.set()
        if journal is not None:
            try:
                journal.add("segment_finished", {"at": time.time(), "failure": failure})
            except (OSError, RuntimeError):
                failure = failure or "durable_evidence_write_failed"
            if (args.output / "plan.json").exists():
                plan = json.loads((args.output / "plan.json").read_bytes())
                result = summarize(plan, journal.rows, min(time.time(), plan["started_at"] + plan["duration_seconds"]))
            else:
                result = {"data_gate_passed": False, "public_preflight_passed": False,
                          "bootstrap_completed": False, "actual_cycles": 0}
            result.update(failure=failure, publication_errors=publication_errors,
                          ready_for_new_paper_study=False, orders_or_private_account_requests=0)
            try:
                journal.seal(result)
            except (OSError, RuntimeError):
                failure = failure or "checkpoint_seal_failed"
                result["failure"] = failure
            if background:
                try:
                    background.close()
                    publication_errors = background.errors
                except Exception:
                    failure = failure or "publication_worker_failed_preserve_local_evidence"
                    result["failure"] = failure
                result["publication_errors"] = publication_errors
                atomic_write(args.output / "summary.json", canonical(result) + b"\n")
            elif mirror and (args.output / "plan.json").exists():
                try:
                    mirror.sync(journal)
                except PublicationError:
                    publication_errors += 1
                    mirror.save()
                    result["publication_errors"] = publication_errors
                    atomic_write(args.output / "summary.json", canonical(result) + b"\n")
            journal.close()
        else:
            result = {"failure": failure, "data_gate_passed": False,
                      "ready_for_new_paper_study": False, "orders_or_private_account_requests": 0}
        print("PMUS_DATA_RELIABILITY=" + json.dumps(result, sort_keys=True))
    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
