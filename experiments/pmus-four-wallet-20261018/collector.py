#!/usr/bin/env python3
"""Public GET-only venue reader and fictional US paper accounts. No order API."""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import math
import os
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from model import (GAME, ONE, QUANTUM, ROUND_DOWN, ZERO, apply_fill, associate, book,
                   canonical, execute, iso, metrics, new_account, number, settle, sha,
                   stamp, valid_open_market, verify_account)
from persistence import Journal, NoRedirect, Publisher, checkpoint

ROOT = Path(__file__).resolve().parent
STOP = False


def allowed(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or u.username or u.password or u.fragment:
        return False
    if u.netloc == "data-api.polymarket.com":
        return u.path in ("/v2/trades", "/v2/positions")
    if u.netloc == "gamma-api.polymarket.com":
        return u.path in ("/markets", "/public-profile")
    if u.netloc == "gateway.polymarket.us":
        return (u.path.startswith("/v1/market/slug/aec-")
                or (u.path.startswith("/v1/markets/aec-") and u.path.endswith(("/book", "/settlement")))
                or (u.path.startswith("/v2/leagues/") and u.path.endswith("/events")))
    return False


class Network:
    def __init__(self, protocol, journal):
        self.p, self.journal = protocol, journal
        self.lock = threading.Lock()
        self.next_request = 0.0
        self.cooldown_until = 0.0

    def get(self, url):
        if not allowed(url):
            raise ValueError("venue URL outside public GET allowlist")
        with self.lock:
            now = time.monotonic()
            if time.time() < self.cooldown_until:
                raise ValueError("rate_limit_cooldown")
            delay = max(0, self.next_request - now)
            self.next_request = max(now, self.next_request) + 1 / self.p["maximum_requests_per_second"]
        if delay:
            time.sleep(delay)
        sent, data, status, headers, error = time.time(), b"", None, {}, None
        try:
            req = urllib.request.Request(url, method="GET", headers={
                "User-Agent": "US-sports-paper-study/1.0", "Accept": "application/json",
                "Cache-Control": "no-cache", "Pragma": "no-cache"})
            with urllib.request.build_opener(NoRedirect()).open(req, timeout=self.p["network_timeout_seconds"]) as response:
                status = response.status
                headers = {k.lower(): v for k, v in response.headers.items()
                           if k.lower() in ("date", "age", "last-modified", "etag", "retry-after")}
                data = response.read(self.p["maximum_response_bytes"] + 1)
                if len(data) > self.p["maximum_response_bytes"]:
                    raise ValueError("response_size_bound")
        except urllib.error.HTTPError as exc:
            status = exc.code
            data = exc.read(self.p["maximum_response_bytes"] + 1)
            headers = {k.lower(): v for k, v in exc.headers.items() if k.lower() in ("date", "age", "retry-after")}
            error = f"HTTP {status}"
            if status == 429:
                try:
                    delay = min(300, max(30, float(headers.get("retry-after", "60"))))
                except ValueError:
                    delay = 60
                self.cooldown_until = time.time() + delay
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        received = time.time()
        record = {"url": url, "method": "GET", "authenticated": False,
                  "sent_at": sent, "received_at": received, "http_status": status,
                  "headers": headers, "body_bytes": len(data), "body_sha256": sha(data),
                  "raw_base64": base64.b64encode(data).decode(), "error": error}
        self.journal.add("http", record)
        self.journal.state["http_calls"] += 1
        if error or status != 200:
            self.journal.state["http_errors"] += 1
            raise ValueError(error or "non200_public_response")
        try:
            path = urllib.parse.urlsplit(url)
            metadata = path.netloc == "gamma-api.polymarket.com" or path.path.startswith("/v1/market/slug/")
            maximum_cache_age = (self.p["maximum_metadata_http_cache_age_seconds"] if metadata
                                 else self.p["maximum_http_cache_age_seconds"])
            if float(headers.get("age", "0")) > maximum_cache_age:
                raise ValueError("stale_http_cache")
            body = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError("non_json_public_response") from exc
        return body, received


def query(base, params):
    return base + "?" + urllib.parse.urlencode(params)


def destination_slugs(source, protocol):
    """Bounded aliases/calendar candidates; association still checks actual identity."""
    slug = source.get("slug", "")
    if not GAME.fullmatch(slug) or source.get("sportsMarketType") != "moneyline":
        raise ValueError("unsupported_source_structure")
    bits = slug.split("-")
    aliases = protocol["slug_team_aliases"].get(bits[0], {})
    teams = [aliases.get(bits[1], bits[1]), aliases.get(bits[2], bits[2])]
    prefix = "aec-" + "-".join([bits[0], *teams]) + "-"
    local_date = datetime.fromtimestamp(stamp(source.get("gameStartTime")),
                                        ZoneInfo(protocol["destination_calendar_timezone"])).date().isoformat()
    return list(dict.fromkeys([prefix + "-".join(bits[3:]), prefix + local_date]))


def pages(network, endpoint, params, wallet, conditions=None):
    out, cursor = [], None
    for _ in range(network.p["maximum_pages_per_read"]):
        request_params = dict(params)
        if cursor:
            request_params["cursor"] = cursor
        body, at = network.get(query(endpoint, request_params))
        rows = body.get("data")
        pagination = body.get("pagination")
        if not isinstance(rows, list) or not isinstance(pagination, dict):
            raise ValueError("missing_pagination_envelope")
        for row in rows:
            if row.get("proxy_wallet", "").lower() != wallet.lower():
                raise ValueError("source_wallet_filter_violation")
            if conditions is not None and row.get("condition_id") not in conditions:
                raise ValueError("source_condition_filter_violation")
        out.extend(rows)
        if pagination.get("has_more") is False:
            return out, at
        next_cursor = pagination.get("next_cursor")
        if not next_cursor or next_cursor == cursor:
            raise ValueError("nonadvancing_source_pagination")
        cursor = next_cursor
    raise ValueError("source_pagination_bound_incomplete")


def read_feed(network, account, state):
    end = int(time.time())
    start = max(int(state["started_at"]), int((account["last_feed_end"] or state["started_at"]) - network.p["feed_overlap_seconds"]))
    params = {"user": account["wallet"], "taker_only": "false", "limit": 1000, "start": start, "end": end}
    rows, at = pages(network, "https://data-api.polymarket.com/v2/trades", params, account["wallet"])
    for row in rows:
        t = float(number(row["timestamp"]))
        if not start <= t <= end:
            raise ValueError("source_trade_window_filter_violation")
        if row.get("side") not in ("BUY", "SELL") or number(row["size"]) < ZERO:
            raise ValueError("source_trade_shape")
    return rows, at, end


def skip(account, reason):
    account["skips"][reason] = account["skips"].get(reason, 0) + 1


def summary(state, protocol):
    now = state["last_cycle_at"]
    return {"study_id": state["study_id"], "code_sha": state["code_sha"],
            "protocol_sha256": state["protocol_sha256"], "checkpoint": state["checkpoint_number"],
            "started_at": iso(state["started_at"]), "entry_collection_ends_at": iso(state["entry_end"]),
            "settlement_hard_stop_at": iso(state["hard_stop"]), "measured_through": iso(now),
            "segment": state["segment"], "segment_complete": state["segment_complete"],
            "terminal": state["terminal"], "fatal_error": state.get("fatal_error"),
            "http_calls": state["http_calls"], "http_errors": state["http_errors"],
            "raw_records": state["raw_seq"], "raw_chain_head": state["raw_hash"],
            "real_orders": 0, "account_capital_is_fictional": True,
            "application_deployed": False, "accounts_are_not_a_combined_portfolio": True,
            "mapping_mode": protocol["mapping_mode"], "health": state["health"],
            "accounts": [metrics(a, state["mappings"], protocol, now, state["started_at"], state["entry_end"], state["terminal"])
                         for a in state["accounts"].values()]}


def render_summary(value):
    lines = ["# Four-wallet US sports paper test", "", f"Study: `{value['study_id']}`",
             f"Measured through: **{value['measured_through']}**", "",
             f"Collection ends: {value['entry_collection_ends_at']}; settlement hard stop: {value['settlement_hard_stop_at']}", "",
             "Each account starts with $1,000 fictional capital. Source account profits are not follower profits. No live orders.", "",
             "| Wallet | Status | Completed distinct markets | Net after modeled fees | Stress net | Open markets | Contracts bought | Elapsed source coverage |",
             "|---|---|---:|---:|---:|---:|---:|---:|"]
    for a in value["accounts"]:
        lines.append(f"| {a['name']} | {a['status']} | {a['completed_distinct_markets']} | ${float(a['completed_net_after_modeled_fees_usd']):.2f} | ${float(a['completed_stress_net_usd']):.2f} | {a['open_distinct_markets']} | {a['simulated_contracts_bought']} | {a['source_poll_coverage_of_elapsed_collection']:.1%} |")
    lines += ["", "`summary.json` contains cash, marks, mark coverage, observed drawdown, fees, timing, quantities and skip reasons.",
              "A successful source poll is not proof of a new fill. See each wallet's latest returned source-trade timestamp separately.",
              "Open positions remain open until a modeled exit or verified US settlement; unavailable marks are not zero profit.",
              "Same-event/team associations follow the US contract's rules and are never labeled EXACT.",
              "Even a promising result is a short screen. Event-cluster resampling does not remove cross-game, day or wallet-selection dependence.", ""]
    if value.get("fatal_error"):
        lines += ["## Collector stopped", "", value["fatal_error"], ""]
    return "\n".join(lines).encode()


class Collector:
    def __init__(self, state, protocol, work):
        self.s, self.p, self.work = state, protocol, Path(work)
        self.journal = Journal(self.work, state)
        self.net = Network(protocol, self.journal)
        self.source_cache, self.us_cache, self.book_cache = {}, {}, {}

    def source_market(self, condition, fresh=False):
        cached = self.source_cache.get(condition)
        if not fresh and cached and time.time() - cached[1] < self.p["metadata_cache_seconds"]:
            return cached[0]
        body, at = self.net.get(query("https://gamma-api.polymarket.com/markets", {"condition_ids": condition}))
        if not isinstance(body, list) or len(body) != 1 or body[0].get("conditionId") != condition:
            raise ValueError("source_market_identity")
        self.source_cache[condition] = (body[0], at)
        return body[0]

    def us_market(self, slug, fresh=False):
        cached = self.us_cache.get(slug)
        if not fresh and cached and time.time() - cached[1] < self.p["metadata_cache_seconds"]:
            return cached[0]
        body, at = self.net.get("https://gateway.polymarket.us/v1/market/slug/" + slug)
        market = body.get("market")
        if not isinstance(market, dict) or market.get("slug") != slug:
            raise ValueError("us_market_identity")
        self.us_cache[slug] = (market, at)
        return market

    def mapping(self, condition):
        if condition in self.s["mappings"]:
            return self.s["mappings"][condition]
        source = self.source_market(condition)
        slug = source.get("slug", "")
        if not GAME.fullmatch(slug) or source.get("sportsMarketType") != "moneyline":
            raise ValueError("unsupported_source_structure")
        for target_slug in destination_slugs(source, self.p):
            try:
                target = self.us_market(target_slug)
            except ValueError as exc:
                if str(exc) != "HTTP 404":
                    raise
                continue
            m = associate(source, target, self.p)
            self.s["mappings"][condition] = m
            self.journal.add("mapping", m)
            return m
        raise ValueError("no_verified_us_counterpart_in_bounded_lookup")

    def current_book(self, slug):
        if slug not in self.book_cache:
            body, at = self.net.get("https://gateway.polymarket.us/v1/markets/" + slug + "/book")
            self.book_cache[slug] = (body, at)
        body, at = self.book_cache[slug]
        return book(body, slug, time.time(), self.p["maximum_book_age_seconds"])

    def source_positions(self, account, conditions):
        result = {}
        for offset in range(0, len(conditions), 20):
            group = conditions[offset:offset + 20]
            params = {"user": account["wallet"], "condition": ",".join(group), "status": "OPEN",
                      "include_archived": "true", "filter_type": "TOKENS", "filter_amount": "0.0001", "limit": 1000}
            rows, at = pages(self.net, "https://data-api.polymarket.com/v2/positions", params, account["wallet"], set(group))
            for row in rows:
                key = (row["condition_id"], row["token_id"])
                if key in result or number(row["current_size"]) < ZERO:
                    raise ValueError("ambiguous_source_inventory")
                sides = self.s["mappings"][row["condition_id"]]["sides"]
                matches = [side for side in sides if side["token"] == row["token_id"]]
                if len(matches) != 1 or row.get("outcome") != matches[0]["outcome"]:
                    raise ValueError("source_inventory_token_or_outcome_mismatch")
                if float(row.get("last_event_at") or 0) > time.time() + 5:
                    raise ValueError("source_inventory_future_timestamp")
                result[key] = row
        return result

    def observe_feed(self, account, rows, at, end):
        previous = account["last_source_poll"] or self.s["started_at"]
        lo, hi = max(previous, self.s["started_at"]), min(at, self.s["entry_end"])
        if hi > lo:
            account["covered_seconds"] += min(hi - lo, 2 * self.p["poll_seconds"])
        account["last_source_poll"] = at
        account["source_polls"] += 1
        account["source_rows_returned"] += len(rows)
        account["last_feed_end"] = end
        if rows:
            newest = max(float(x["timestamp"]) for x in rows)
            account["last_source_trade"] = max(newest, account["last_source_trade"] or 0)
        for row in sorted(rows, key=lambda x: float(x["timestamp"])):
            t = float(row["timestamp"])
            if t <= self.s["started_at"]:
                continue
            condition = row["condition_id"]
            key = sha(canonical({k: row.get(k) for k in ("transaction_hash", "condition_id", "token_id", "timestamp", "side", "price", "size")}))
            if key in account["seen"]:
                continue
            account["seen"][key] = t
            if row.get("slug") != row.get("event_slug") or not GAME.fullmatch(row.get("slug", "")):
                skip(account, "unsupported_market_type_or_league")
                continue
            if time.time() - t > self.p["maximum_signal_age_seconds"]:
                skip(account, "stale_source_trade")
                continue
            signal = account["pending"].setdefault(condition, {"first_seen": at, "rows": []})
            signal["rows"].append(row)
            signal["latest_at"] = t
        account["seen"] = {k: v for k, v in account["seen"].items() if v >= time.time() - self.p["feed_overlap_seconds"] - 120}

    def trade(self, account, condition, mapping, side, action, q, signal=None):
        step = number(mapping["quantity_step"])
        q = number(q).quantize(step, rounding=ROUND_DOWN)
        if q < step:
            return False
        target = self.us_market(mapping["us_slug"])
        if not valid_open_market(target):
            raise ValueError("us_market_not_open_and_tradable")
        if number(target.get("feeCoefficient")) != number(mapping["fee_coefficient"]):
            raise ValueError("fee_schedule_drift")
        account["quote_attempts"] += 1
        try:
            snapshot = self.current_book(mapping["us_slug"])
            fill = execute(snapshot, mapping["sides"][side]["long"], action, q, mapping["fee_coefficient"])
            if action == "BUY":
                if not signal:
                    raise ValueError("new_entry_without_fresh_executed_buy")
                current_join = associate(self.source_market(condition), target, self.p)
                if current_join["sides"] != mapping["sides"] or current_join["start_at"] != mapping["start_at"]:
                    raise ValueError("changed_side_identity_or_scheduled_time")
                at = time.time()
                fresh_buys = [x for x in signal["rows"] if x["side"] == "BUY" and x["token_id"] == mapping["sides"][side]["token"]
                              and 0 <= at - float(x["timestamp"]) <= self.p["maximum_signal_age_seconds"]]
                if not fresh_buys or at - signal["first_seen"] < self.p["minimum_observation_delay_seconds"]:
                    raise ValueError("no_fresh_confirmed_buy_for_net_side")
                if at > self.s["entry_end"] or self.s.get("fatal_error"):
                    raise ValueError("entry_collection_ended")
                reference = max(fresh_buys, key=lambda x: x["timestamp"])
                if number(fill["average_price"]) > number(reference["price"]) + number(self.p["maximum_worse_entry_price"]):
                    raise ValueError("entry_price_difference_gate")
                open_count = sum(number(p["quantity"]) > ZERO for p in account["positions"].values())
                if not number(account["positions"].get(condition, {}).get("quantity", "0")) and open_count >= self.p["maximum_open_markets_per_account"]:
                    raise ValueError("open_market_limit")
                fill["source_trade_at"] = reference["timestamp"]
                fill["signal_first_seen_at"] = signal["first_seen"]
                fill["source_to_paper_seconds"] = at - reference["timestamp"]
                fill["game_phase_by_scheduled_time"] = "PREGAME" if at < mapping["start_at"] else "IN_PLAY_OR_DELAYED"
            row = apply_fill(account, condition, mapping, side, action, fill, time.time(), self.p["stress_cost_per_contract_per_trade"])
            self.journal.add("paper_fill", {"wallet": account["wallet"], **row})
            return True
        except ValueError:
            account["quote_failures"] += 1
            raise

    def service_account(self, account):
        now = time.time()
        for condition in list(account["pending"]):
            if now - account["pending"][condition]["latest_at"] > self.p["maximum_signal_age_seconds"]:
                skip(account, "signal_expired_without_entry")
                del account["pending"][condition]
        active = {c for c, p in account["positions"].items() if number(p["quantity"]) > ZERO}
        considered = sorted(active | set(account["pending"]))
        mapped = []
        for condition in considered:
            pending = account["pending"].get(condition)
            if pending and now - pending["first_seen"] < self.p["minimum_observation_delay_seconds"] and condition not in active:
                continue
            try:
                self.mapping(condition)
                mapped.append(condition)
            except ValueError as exc:
                skip(account, str(exc))
                account["pending"].pop(condition, None)
        if not mapped:
            return
        try:
            inventory = self.source_positions(account, mapped)
        except ValueError as exc:
            skip(account, "source_inventory_unavailable:" + str(exc))
            return
        for condition in mapped:
            mapping = self.s["mappings"][condition]
            pos = account["positions"].get(condition)
            held = number(pos["quantity"]) if pos else ZERO
            if pos and pos.get("settled"):
                continue
            try:
                target = self.us_market(mapping["us_slug"])
                if target.get("status") == "MARKET_STATUS_RESOLVED" and target.get("closed") is True:
                    if pos and number(pos["quantity"]) > ZERO:
                        settlement, at = self.net.get("https://gateway.polymarket.us/v1/markets/" + mapping["us_slug"] + "/settlement")
                        price = number(settlement.get("settlement"))
                        if settlement.get("slug") != mapping["us_slug"] or not ZERO <= price <= ONE:
                            raise ValueError("invalid_us_settlement_response")
                        long_side = next(s for s in target["marketSides"] if s["long"])
                        if number(long_side["price"]) != price:
                            raise ValueError("us_resolution_and_settlement_disagree")
                        row = settle(account, condition, mapping, price, at)
                        pos["settled"] = True
                        self.journal.add("us_settlement", {"wallet": account["wallet"], **row})
                    account["pending"].pop(condition, None)
                    continue
                source = self.source_market(condition)
                # A foreign resolution/redemption must never synthesize a SELL or a US settlement.
                if source.get("closed") or source.get("archived") or not source.get("active"):
                    skip(account, "source_resolved_or_unservable_wait_for_us")
                    continue
                if sha(source["description"].encode()) != mapping["source_rules_sha256"] or sha(target["description"].encode()) != mapping["us_rules_sha256"]:
                    skip(account, "contract_rules_changed_no_new_entries")
                    account["pending"].pop(condition, None)
                rows = [inventory.get((condition, side["token"])) for side in mapping["sides"]]
                if any(row and row.get("redeemable") for row in rows):
                    skip(account, "source_resolved_wait_for_us")
                    continue
                qty = [number(row["current_size"]) if row else ZERO for row in rows]
                if not any(rows) and held:
                    closed_rows, _ = pages(self.net, "https://data-api.polymarket.com/v2/positions", {
                        "user": account["wallet"], "condition": condition, "status": "CLOSED", "limit": 1000},
                        account["wallet"], {condition})
                    held_token = mapping["sides"][pos["side"]]["token"]
                    if not any(row.get("token_id") == held_token and number(row.get("current_size")) == ZERO for row in closed_rows):
                        raise ValueError("empty_source_inventory_without_closed_position_confirmation")
                net = qty[0] - qty[1]
                side = 0 if net >= ZERO else 1
                magnitude = abs(net)
                signal = account["pending"].get(condition)
                latest_inventory_at = max((float(row.get("last_event_at") or 0) for row in rows if row), default=0)
                prior_inventory = account["net_snapshots"].get(condition, {})
                if any(rows) and latest_inventory_at < prior_inventory.get("source_last_event", 0):
                    raise ValueError("source_inventory_clock_regression")
                if signal:
                    if latest_inventory_at < signal["latest_at"] and not held:
                        raise ValueError("source_inventory_lags_signal")
                account["net_snapshots"][condition] = {"at": now, "net": str(net), "source_last_event": latest_inventory_at}
                if held and (magnitude == ZERO or side != pos["side"]):
                    if not self.trade(account, condition, mapping, pos["side"], "SELL", held):
                        continue
                    held = ZERO
                if magnitude == ZERO or (not held and magnitude < number(self.p["minimum_source_net_quantity"])):
                    continue
                if not held and not signal:
                    continue
                if not pos or not held:
                    peak = magnitude
                else:
                    peak = max(magnitude, number(pos["peak_source_net"]))
                desired = (number(self.p["maximum_contracts_per_market"]) * magnitude / peak).quantize(number(mapping["quantity_step"]), rounding=ROUND_DOWN)
                if pos:
                    pos["peak_source_net"] = str(peak)
                if desired < held:
                    self.trade(account, condition, mapping, side, "SELL", held - desired)
                elif desired > held and signal:
                    if self.trade(account, condition, mapping, side, "BUY", desired - held, signal):
                        account["positions"][condition]["peak_source_net"] = str(peak)
                        # A previously copied BUY cannot trigger another opening after an exit.
                        account["pending"].pop(condition, None)
            except ValueError as exc:
                skip(account, str(exc))

    def mark(self, account):
        account["mark_checks"] += 1
        equity = number(account["cash"])
        for condition, pos in account["positions"].items():
            q = number(pos["quantity"])
            if not q:
                continue
            mapping = self.s["mappings"][condition]
            try:
                value = execute(self.current_book(mapping["us_slug"]), mapping["sides"][pos["side"]]["long"], "SELL", q, mapping["fee_coefficient"])
                equity += number(value["gross"]) - number(value["fee"])
            except ValueError:
                return
        account["complete_mark_checks"] += 1
        peak = max(number(account["peak_equity"]), equity)
        account["peak_equity"] = str(peak)
        account["max_drawdown_usd"] = str(max(number(account["max_drawdown_usd"]), peak - equity))
        account["last_equity"] = str(equity)
        account["last_equity_at"] = time.time()

    def cycle(self):
        self.book_cache = {}
        accounts = list(self.s["accounts"].values())
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(read_feed, self.net, account, self.s) for account in accounts]
            for account, future in zip(accounts, futures):
                try:
                    self.observe_feed(account, *future.result())
                except ValueError as exc:
                    account["source_poll_failures"] += 1
                    skip(account, "source_feed_error:" + str(exc))
        for account in accounts:
            self.service_account(account)
            self.mark(account)
            verify_account(account, self.p["starting_capital_usd"])
        self.s["cycles"] += 1
        self.s["last_cycle_at"] = time.time()
        self.s["health"] = {"source_poll_age_seconds": {a["name"]: (self.s["last_cycle_at"] - a["last_source_poll"] if a["last_source_poll"] else None) for a in accounts},
                            "freshly_observed_source_trades": {a["name"]: a["last_source_trade"] for a in accounts}}
        if self.s["last_cycle_at"] >= self.s["hard_stop"]:
            self.s["terminal"] = True
        elif self.s["last_cycle_at"] >= self.s["entry_end"] and not any(number(p["quantity"]) for a in accounts for p in a["positions"].values()):
            self.s["terminal"] = True

    def publish(self, publisher, bootstrap=False):
        files, manifest = checkpoint(self.s, self.p, self.journal, {}, self.work / "output")
        value = summary(self.s, self.p)
        files["summary.json"] = canonical(value)
        files["SUMMARY.md"] = render_summary(value)
        (self.work / "output" / "summary.json").write_bytes(files["summary.json"])
        (self.work / "output" / "SUMMARY.md").write_bytes(files["SUMMARY.md"])
        commit = publisher.publish(files, self.s, bootstrap=bootstrap)
        self.s["last_manifest_sha256"] = sha(canonical(manifest))
        self.journal.reset()
        print(json.dumps({"checkpoint": self.s["checkpoint_number"], "commit": commit,
                          "measured_through": value["measured_through"], "cycles": self.s["cycles"],
                          "accounts": [{k: a[k] for k in ("name", "completed_distinct_markets", "open_distinct_markets", "simulated_contracts_bought")} for a in value["accounts"]]}), flush=True)


def bootstrap(protocol, code_sha, work):
    at = time.time()
    s = {"study_id": protocol["study_id"], "code_sha": code_sha,
         "protocol_sha256": sha((ROOT / "protocol.json").read_bytes()),
         "started_at": at, "entry_end": at + protocol["entry_collection_hours"] * 3600,
         "hard_stop": at + (protocol["entry_collection_hours"] + protocol["maximum_settlement_drain_hours"]) * 3600,
         "last_cycle_at": at, "checkpoint_number": 0, "segment": -1, "segment_complete": True,
         "terminal": False, "fatal_error": None, "raw_hash": "0" * 64, "raw_seq": 0,
         "raw_uncompressed_bytes": 0, "raw_compressed_bytes": 0, "http_calls": 0, "http_errors": 0,
         "cycles": 0, "mappings": {}, "accounts": {}, "health": {}}
    c = Collector(s, protocol, work)
    for wallet in protocol["wallets"]:
        a = new_account(wallet["name"], wallet["address"], protocol["starting_capital_usd"])
        clock = int(time.time())
        body, received = c.net.get(query("https://data-api.polymarket.com/v2/trades", {
            "user": wallet["address"], "taker_only": "false", "limit": 100,
            "start": clock - protocol["startup_maximum_last_trade_age_seconds"], "end": clock}))
        if not isinstance(body.get("data"), list) or any(t.get("proxy_wallet", "").lower() != wallet["address"].lower() for t in body["data"]):
            raise ValueError("bootstrap source identity failed")
        if not body["data"] or max(float(x["timestamp"]) for x in body["data"]) < time.time() - protocol["startup_maximum_last_trade_age_seconds"]:
            raise ValueError("bootstrap wallet has no sufficiently recent returned activity")
        a["last_source_trade"] = max(float(x["timestamp"]) for x in body["data"])
        a["last_source_poll"] = received
        s["accounts"][wallet["address"]] = a
    good_books = 0
    for seed in protocol["readiness_conditions"]:
        m = c.mapping(seed)
        try:
            c.current_book(m["us_slug"])
            good_books += 1
        except ValueError as exc:
            c.journal.add("readiness_quote_issue", {"condition": seed, "reason": str(exc)})
    if not good_books:
        raise ValueError("no timestamp-qualified US readiness book")
    # The actual study epoch begins after successful bootstrap reads. Past holdings/fills stay unbooked.
    at = time.time()
    s.update(started_at=at, entry_end=at + protocol["entry_collection_hours"] * 3600,
             hard_stop=at + (protocol["entry_collection_hours"] + protocol["maximum_settlement_drain_hours"]) * 3600,
             last_cycle_at=at)
    for a in s["accounts"].values():
        a["last_feed_end"] = int(at)
    s["health"] = {"bootstrap_source_wallets_verified": len(s["accounts"]), "timestamp_qualified_us_readiness_books": good_books}
    c.journal.add("study_started", {"at": at, "code_sha": code_sha, "protocol_sha256": s["protocol_sha256"]})
    return c


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap", action="store_true")
    parser.add_argument("--segment", type=int, default=-1)
    parser.add_argument("--seconds", type=int, default=18000)
    parser.add_argument("--work", default="paper-work")
    args = parser.parse_args()
    protocol = json.loads((ROOT / "protocol.json").read_text())
    code_sha = os.environ.get("GITHUB_SHA")
    if not code_sha or len(code_sha) != 40:
        raise ValueError("immutable code SHA required")
    publisher = Publisher(protocol, code_sha)
    if args.bootstrap:
        if publisher.ref():
            raise ValueError("duplicate bootstrap refused")
        c = bootstrap(protocol, code_sha, args.work)
        c.publish(publisher, bootstrap=True)
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write("terminal=false\n")
        return
    s = publisher.load(args.segment - 1, sha((ROOT / "protocol.json").read_bytes()))
    if s["terminal"]:
        print("Terminal checkpoint preserved; no new collection.")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write("terminal=true\n")
        return
    s.update(segment=args.segment, segment_complete=False)
    c = Collector(s, protocol, args.work)
    started = time.monotonic()
    last_publish = started
    try:
        c.journal.add("segment_started", {"segment": args.segment, "at": time.time()})
        c.publish(publisher)
        while not STOP and not s["terminal"] and time.monotonic() - started < args.seconds:
            tick = time.monotonic()
            c.cycle()
            if time.monotonic() - last_publish >= protocol["checkpoint_seconds"] or s["terminal"]:
                c.publish(publisher)
                last_publish = time.monotonic()
            remaining = protocol["poll_seconds"] - (time.monotonic() - tick)
            if remaining > 0:
                time.sleep(remaining)
        if STOP:
            raise RuntimeError("collector interrupted; checkpoint preserved, no automatic rewind")
        s["segment_complete"] = True
        s["last_cycle_at"] = time.time()
        c.publish(publisher)
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write("terminal=" + str(s["terminal"]).lower() + "\n")
    except Exception as exc:
        s["fatal_error"] = f"{type(exc).__name__}: {exc}"
        s["terminal"] = True
        s["last_cycle_at"] = time.time()
        try:
            c.journal.add("fatal_error", {"at": s["last_cycle_at"], "error": s["fatal_error"]})
            c.publish(publisher)
        except Exception as save_exc:
            print(f"Checkpoint publication also failed: {type(save_exc).__name__}", flush=True)
        raise


if __name__ == "__main__":
    def stop(signum, frame):
        global STOP
        STOP = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    main()
