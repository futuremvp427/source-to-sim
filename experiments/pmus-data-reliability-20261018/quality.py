"""Read-only US data diagnostics; no accounts, orders, or follower execution."""
from __future__ import annotations

import collections
import datetime as dt
import hashlib
import importlib.util
import json
import math
import re
from email.utils import parsedate_to_datetime
from pathlib import Path

PINNED_CODE = "130c37763b2d8d7766ea181e398056a50e4a6c66"
PINNED_MODEL_GIT_SHA = "bbb94f5f9ac6f826660cd35eafa135eb115e5cfa"
PINNED_PROTOCOL_SHA256 = "1be659edf8286da821eacd314f81fee3c46f8a5ff52a16c4bb5d56cfb02f108f"
REFERENCE = Path(__file__).resolve().parent.parent / "pmus-four-wallet-20261018"
_bytes = (REFERENCE / "model.py").read_bytes()
if hashlib.sha1(b"blob " + str(len(_bytes)).encode() + b"\0" + _bytes).hexdigest() != PINNED_MODEL_GIT_SHA:
    raise RuntimeError("pinned_model_identity_mismatch")
_protocol = (REFERENCE / "protocol.json").read_bytes()
if hashlib.sha256(_protocol).hexdigest() != PINNED_PROTOCOL_SHA256:
    raise RuntimeError("pinned_protocol_identity_mismatch")
_spec = importlib.util.spec_from_file_location("quality_pinned_model", REFERENCE / "model.py")
MODEL = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MODEL)
PROTOCOL = json.loads(_protocol)
SLUG = re.compile(r"^aec-[a-z0-9-]{1,180}$")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def finite(value):
    if isinstance(value, bool):
        raise ValueError("invalid_number")
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("invalid_number")
    return value


def transport(response, maximum_age=20):
    """Age is authoritative when present; a fresh Date cannot override old Age."""
    issues, detail = [], {}
    if response.get("error") or response.get("status") != 200:
        return [response.get("error") or f"http_{response.get('status')}"], detail
    headers = {k.lower(): v for k, v in response.get("headers", {}).items()}
    now = finite(response["received_at"])
    try:
        date = parsedate_to_datetime(headers["date"])
        if date.tzinfo is None:
            raise ValueError("date_without_timezone")
        detail["http_date_age_seconds"] = now - date.timestamp()
        if not -5 <= detail["http_date_age_seconds"] <= maximum_age:
            issues.append("stale_or_future_http_date")
    except (KeyError, TypeError, ValueError, OverflowError):
        issues.append("missing_or_invalid_http_date")
    detail["age_header_present"] = "age" in headers
    if "age" in headers:
        try:
            age = finite(headers["age"])
            detail["http_cache_age_seconds"] = age
            if age < 0:
                issues.append("invalid_http_age")
            elif age > maximum_age:
                issues.append("stale_http_cache")
        except (TypeError, ValueError):
            issues.append("invalid_http_age")
    return issues, detail


def inspect_book(response, slug, quantity="10", now=None):
    issues, detail = transport(response)
    out = {"slug": slug, "usable": False, "issues": issues, **detail}
    if response.get("status") != 200 or response.get("error"):
        return out
    try:
        body = response["body"]
        md = body.get("marketData", {})
        out["market_state"] = md.get("state")
        out["book_at"] = MODEL.stamp(md.get("transactTime"))
        at = finite(response["received_at"] if now is None else now)
        out["book_age_seconds"] = at - out["book_at"]
        # Continue parsing even if cache age fails: retain ALL measured causes.
        value = MODEL.book(body, slug, at, 60)
        q = MODEL.number(quantity)
        if not 0 < q <= 10:
            raise ValueError("diagnostic_quantity_out_of_bounds")
        sells = {}
        for long in (True, False):
            try:
                x = MODEL.execute(value, long, "SELL", q, "0.0695")
                sells["long" if long else "short"] = {
                    "quantity": x["quantity"], "gross": x["gross"], "fee": x["fee"]}
            except ValueError as exc:
                issues.append(("long_" if long else "short_") + str(exc))
        out["sell_depth_diagnostics"] = sells
        normalized = {side: [[str(p.normalize()), str(q.normalize())] for p, q in value[side]]
                      for side in ("bids", "offers")}
        out["book_fingerprint"] = digest({"slug": slug, **normalized, "state": md.get("state")})
    except (ValueError, TypeError, KeyError, AttributeError, ArithmeticError) as exc:
        issues.append(str(exc) or type(exc).__name__)
    out["issues"] = list(dict.fromkeys(issues))
    out["usable"] = not out["issues"]
    return out


def resolve_catalog(source, catalog, complete):
    """Match real catalog entries, never construct a US slug from a foreign slug."""
    if not complete:
        return {"status": "catalog_incomplete", "mapping": None}
    candidates = {}
    for target in catalog:
        try:
            if not SLUG.fullmatch(target.get("slug", "")) or not MODEL.valid_open_market(target):
                continue
            mapping = MODEL.associate(source, target, PROTOCOL)
            if mapping["exact_approved"] is not False:
                raise ValueError("unexpected_exact_association")
            candidates[target["slug"]] = mapping
        except (ValueError, TypeError, KeyError, AttributeError, ArithmeticError):
            continue
    if len(candidates) != 1:
        return {"status": "no_verified_catalog_match" if not candidates else "ambiguous_catalog_match",
                "mapping": None, "candidates": sorted(candidates)}
    return {"status": "matched", "mapping": next(iter(candidates.values()))}


def compare_stream(rest, stream, maximum_skew_seconds=2):
    """Offline comparison only. A heartbeat is NOT a book or a freshness reset."""
    if not rest.get("usable") or not stream.get("usable"):
        return {"matched": False, "reason": "unusable_snapshot"}
    if rest["slug"] != stream["slug"]:
        return {"matched": False, "reason": "different_market"}
    if abs(rest["book_at"] - stream["book_at"]) > maximum_skew_seconds:
        return {"matched": False, "reason": "snapshot_time_skew"}
    same = rest["book_fingerprint"] == stream["book_fingerprint"]
    return {"matched": same, "reason": "same_book" if same else "book_mismatch",
            "proves_authenticated_live_feed": False}


def readiness(plan, cycles, now):
    """Missing/failed ticks stay in the denominator; no short-run green result."""
    interval, duration = plan["interval_seconds"], plan["planned_duration_seconds"]
    if interval <= 0 or duration < 86400 or duration % interval:
        raise ValueError("invalid_frozen_readiness_window")
    count = int(duration / interval)
    expected = min(count, max(0, math.ceil((now - plan["started_at"]) / interval)))
    by_tick = {}
    for row in cycles:
        tick = row["tick"]
        if tick in by_tick or type(tick) is not int or not 0 <= tick < count:
            raise ValueError("duplicate_or_invalid_tick")
        by_tick[tick] = row
    markets = {}
    for condition, match in plan["matches"].items():
        good, settled, errors, phases = 0, 0, collections.Counter(), collections.defaultdict(lambda: [0, 0])
        mapping = match.get("mapping")
        for tick in range(expected):
            at = plan["started_at"] + tick * interval
            phase = "UNKNOWN" if not mapping else ("PREGAME" if at < mapping["start_at"] else "IN_PLAY_OR_POSTGAME")
            phases[phase][1] += 1
            x = by_tick.get(tick, {}).get("markets", {}).get(condition)
            valid = bool(mapping and x and x.get("usable"))
            if valid and x.get("kind") == "official_us_settlement":
                settled += 1
            if valid:
                good += 1
                phases[phase][0] += 1
            else:
                errors.update((x or {}).get("issues") or [match["status"] if not mapping else "missing_scheduled_observation"])
        markets[condition] = {"slug": mapping["us_slug"] if mapping else None,
                              "valid_observations": good, "official_us_settlement_ticks": settled,
                              "valid_book_ticks": good - settled, "expected_elapsed_ticks": expected,
                              "planned_ticks": count, "coverage_elapsed": good / expected if expected else 0,
                              "coverage_full_planned": good / count,
                              "phase_valid_and_expected": dict(phases), "failure_reasons": dict(errors)}
    passed = (bool(markets) and now >= plan["started_at"] + duration
              and all(x["coverage_full_planned"] >= 0.95 for x in markets.values())
              and all(x["valid_book_ticks"] >= 30 for x in markets.values())
              and all(good / expected >= .95 for x in markets.values()
                      for good, expected in x["phase_valid_and_expected"].values() if expected)
              and any(x["phase_valid_and_expected"].get("PREGAME", [0, 0])[1] for x in markets.values())
              and any(x["phase_valid_and_expected"].get("IN_PLAY_OR_POSTGAME", [0, 0])[1] for x in markets.values()))
    return {"public_observation_gate_passed": passed, "markets": markets,
            "official_stream_validation": "BLOCKED_NO_APPROVED_READ_ONLY_CREDENTIALS",
            "ready_for_new_paper_study": False, "no_orders_or_accounts": True,
            "actual_live_phase_verified": False,
            "note": "Phases use scheduled start, not verified game-in-progress status. Public diagnostics cannot substitute for the unperformed official live-feed comparison. Final US settlements are reported separately from tradable quotes."}
