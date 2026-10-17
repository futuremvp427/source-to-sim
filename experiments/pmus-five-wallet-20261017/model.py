"""Pure accounting and validation for the independent US paper follower."""
from __future__ import annotations

import hashlib
import json
import random
import re
import statistics
import unicodedata
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_EVEN

ZERO = Decimal("0")
ONE = Decimal("1")
QUANTUM = Decimal("0.01")
CENT = Decimal("0.01")
GAME = re.compile(r"^(nfl|cfb|nba|nhl|mlb|wnba)-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$")


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def number(value):
    if isinstance(value, bool) or value is None:
        raise ValueError("invalid numeric value")
    value = Decimal(str(value))
    if not value.is_finite():
        raise ValueError("nonfinite numeric value")
    return value


def stamp(value):
    if not isinstance(value, str):
        raise ValueError("missing source timestamp")
    value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        raise ValueError("timestamp lacks timezone")
    return value.timestamp()


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def norm(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value or "").casefold() if c.isalnum())


def side_names(side):
    team = side.get("team") or {}
    values = {norm(side.get("description"))}
    values.update(norm(team.get(k)) for k in ("name", "safeName", "alias"))
    return values - {""}


def associate(source, target, protocol):
    """Same event/team association, explicitly accepting the US contract's rules."""
    slug = source.get("slug", "")
    match = GAME.fullmatch(slug)
    if not match or source.get("sportsMarketType") != "moneyline":
        raise ValueError("unsupported_source_structure")
    league = match.group(1)
    if target.get("category") != "sports" or target.get("marketType") != "moneyline":
        raise ValueError("unsupported_us_structure")
    kind = target.get("sportsMarketType", "")
    if kind != "moneyline" and not kind.endswith("_full_game_winner"):
        raise ValueError("unsupported_us_period")
    if stamp(source.get("gameStartTime")) != stamp(target.get("gameStartTime")):
        raise ValueError("scheduled_time_mismatch")
    if not source.get("description") or not target.get("description"):
        raise ValueError("missing_contract_rules")
    outcomes = json.loads(source["outcomes"])
    tokens = json.loads(source["clobTokenIds"])
    sides = target.get("marketSides", [])
    if len(outcomes) != 2 or len(tokens) != 2 or len(set(tokens)) != 2 or len(sides) != 2:
        raise ValueError("nonbinary_or_ambiguous_sides")
    if {s.get("long") for s in sides} != {True, False}:
        raise ValueError("ambiguous_us_orientation")
    joins = []
    for i, outcome in enumerate(outcomes):
        candidate = norm(outcome)
        candidate = norm(protocol.get("team_aliases", {}).get(league, {}).get(candidate, candidate))
        matched = [s for s in sides if candidate in side_names(s)]
        if len(matched) != 1 or matched[0].get("team", {}).get("league") != league:
            raise ValueError("ambiguous_team_or_league")
        s = matched[0]
        joins.append({"outcome": outcome, "token": tokens[i], "long": s["long"],
                      "us_side_id": str(s["id"]), "us_outcome": s["description"]})
    if len({x["us_side_id"] for x in joins}) != 2:
        raise ValueError("nonbijective_outcome_join")
    coefficient = number(target.get("feeCoefficient"))
    if coefficient != number(protocol["taker_fee_coefficient"]):
        raise ValueError("fee_schedule_drift")
    step = number(target.get("minimumTradeQty"))
    if step not in (CENT, ONE):
        raise ValueError("unverified_contract_quantity_step")
    return {"condition": source["conditionId"], "source_slug": slug,
            "us_slug": target["slug"], "league": league,
            "start_at": stamp(source["gameStartTime"]), "sides": joins,
            "fee_coefficient": str(coefficient), "quantity_step": str(step),
            "source_rules_sha256": sha(source["description"].encode()),
            "us_rules_sha256": sha(target["description"].encode()),
            "mapping_class": "SAME_EVENT_TEAM_US_RULES_DIFFERENT_CONTINGENCIES",
            "exact_approved": False}


def valid_open_market(market):
    return (market.get("active") is True and market.get("closed") is False
            and market.get("status") == "MARKET_STATUS_OPEN"
            and len(market.get("marketSides", [])) == 2
            and all(s.get("tradable") is True for s in market["marketSides"]))


def book(body, slug, now, max_age):
    b = body.get("marketData", {})
    if b.get("marketSlug") != slug or b.get("state") != "MARKET_STATE_OPEN":
        raise ValueError("book_identity_or_state")
    at = stamp(b.get("transactTime"))
    if not -5 <= now - at <= max_age:
        raise ValueError("stale_or_future_book")
    out = {"at": at}
    for key, reverse in (("bids", True), ("offers", False)):
        if not isinstance(b.get(key), list):
            raise ValueError("malformed_book")
        levels = []
        for v in b[key]:
            if v.get("px", {}).get("currency") != "USD":
                raise ValueError("book_currency")
            p, q = number(v["px"]["value"]), number(v["qty"])
            if not ZERO < p < ONE or q < ZERO:
                raise ValueError("invalid_book_level")
            if q:
                levels.append((p, q))
        out[key] = sorted(levels, reverse=reverse)
    if not out["bids"] or not out["offers"]:
        raise ValueError("one_sided_book")
    if out["bids"][0][0] >= out["offers"][0][0]:
        raise ValueError("crossed_or_locked_book")
    return out


def execute(book_value, long, action, quantity, theta):
    """Full requested quantity or no modeled fill. Opposite side is complementary."""
    quantity = number(quantity)
    if quantity <= ZERO:
        raise ValueError("nonpositive_fill")
    if long:
        levels = book_value["offers" if action == "BUY" else "bids"]
    else:
        levels = [(ONE - p, q) for p, q in book_value["bids" if action == "BUY" else "offers"]]
    levels = sorted(levels, reverse=action == "SELL")
    remaining, gross, exact_fee = quantity, ZERO, ZERO
    walked = []
    for price, available in levels:
        taken = min(available, remaining)
        gross += price * taken
        exact_fee += number(theta) * taken * price * (ONE - price)
        walked.append([str(price), str(taken)])
        remaining -= taken
        if not remaining:
            break
    if remaining:
        raise ValueError("insufficient_full_quantity_depth")
    # Venue caps total aggressive-order commission at this rounded exact sum.
    # Aggregated depth lacks resting-order IDs, so this is a conservative fee model.
    fee = exact_fee.quantize(CENT, rounding=ROUND_HALF_EVEN)
    return {"quantity": str(quantity), "gross": str(gross), "fee": str(fee),
            "average_price": str(gross / quantity), "levels": walked,
            "book_at": book_value["at"]}


def new_account(name, wallet, capital):
    return {"name": name, "wallet": wallet, "cash": str(capital), "positions": {},
            "games": {}, "ledger": [], "skips": {}, "source_polls": 0,
            "source_poll_failures": 0, "source_rows_returned": 0,
            "last_source_poll": None, "last_source_trade": None,
            "covered_seconds": 0.0, "mark_checks": 0, "complete_mark_checks": 0,
            "peak_equity": str(capital), "max_drawdown_usd": "0",
            "last_equity": str(capital), "last_equity_at": None,
            "seen": {}, "pending": {}, "last_feed_end": None,
            "net_snapshots": {}, "quote_attempts": 0, "quote_failures": 0}


def apply_fill(account, condition, mapping, side_index, action, fill, now, stress):
    pos = account["positions"].setdefault(condition, {"side": side_index, "quantity": "0", "peak_source_net": "0"})
    q = number(fill["quantity"])
    before = number(pos["quantity"])
    if action == "SELL" and (pos["side"] != side_index or q > before):
        raise ValueError("paper_oversell")
    if action == "BUY" and before and pos["side"] != side_index:
        raise ValueError("unclosed_opposite_position")
    gross, fee = number(fill["gross"]), number(fill["fee"])
    delta = -gross - fee if action == "BUY" else gross - fee
    if number(account["cash"]) + delta < ZERO:
        raise ValueError("fictional_cash_limit")
    pos["side"] = side_index
    pos["quantity"] = str(before + q if action == "BUY" else before - q)
    account["cash"] = str(number(account["cash"]) + delta)
    game = account["games"].setdefault(mapping["us_slug"], {
        "cash_delta": "0", "stress_cost": "0", "fees": "0", "bought": "0",
        "sold": "0", "settled": "0", "entry_fills": 0, "exit_fills": 0})
    game["cash_delta"] = str(number(game["cash_delta"]) + delta)
    game["stress_cost"] = str(number(game["stress_cost"]) + q * number(stress))
    game["fees"] = str(number(game["fees"]) + fee)
    field = "bought" if action == "BUY" else "sold"
    game[field] = str(number(game[field]) + q)
    game["entry_fills" if action == "BUY" else "exit_fills"] += 1
    row = {"at": now, "condition": condition, "us_slug": mapping["us_slug"],
           "side": side_index, "action": action, "cash_delta": str(delta), **fill}
    account["ledger"].append(row)
    return row


def settle(account, condition, mapping, long_settlement, now):
    pos = account["positions"][condition]
    q = number(pos["quantity"])
    p = number(long_settlement)
    if not ZERO <= p <= ONE:
        raise ValueError("invalid_settlement")
    if not mapping["sides"][pos["side"]]["long"]:
        p = ONE - p
    proceeds = q * p
    account["cash"] = str(number(account["cash"]) + proceeds)
    game = account["games"][mapping["us_slug"]]
    game["cash_delta"] = str(number(game["cash_delta"]) + proceeds)
    game["settled"] = str(number(game["settled"]) + q)
    pos["quantity"] = "0"
    row = {"at": now, "condition": condition, "us_slug": mapping["us_slug"],
           "side": pos["side"], "action": "SETTLE", "quantity": str(q),
           "gross": str(proceeds), "fee": "0", "cash_delta": str(proceeds),
           "settlement_price": str(p)}
    account["ledger"].append(row)
    return row


def verify_account(account, capital):
    cash = number(capital)
    quantities = {}
    for row in account["ledger"]:
        cash += number(row["cash_delta"])
        key = (row["condition"], row["side"])
        q = number(row["quantity"])
        quantities[key] = quantities.get(key, ZERO) + (q if row["action"] == "BUY" else -q)
        if quantities[key] < ZERO or cash < ZERO:
            raise ValueError("negative_replayed_cash_or_inventory")
    if cash != number(account["cash"]):
        raise ValueError("ledger_cash_mismatch")
    for condition, p in account["positions"].items():
        if quantities.get((condition, p["side"]), ZERO) != number(p["quantity"]):
            raise ValueError("ledger_position_mismatch")
        for key, qty in quantities.items():
            if key[0] == condition and key[1] != p["side"] and qty:
                raise ValueError("unclosed_replayed_opposite_side")
    return True


def metrics(account, mappings, protocol, now, started, entry_end, terminal=False):
    open_games = {mappings[c]["us_slug"] for c, p in account["positions"].items()
                  if number(p["quantity"]) > ZERO}
    finished = [v for k, v in account["games"].items() if k not in open_games and v["entry_fills"]]
    net = sum((number(x["cash_delta"]) for x in finished), ZERO)
    stress = sum((number(x["cash_delta"]) - number(x["stress_cost"]) for x in finished), ZERO)
    elapsed = max(0, min(now, entry_end) - started)
    coverage = min(1.0, account["covered_seconds"] / elapsed) if elapsed else 0.0
    window_coverage = min(1.0, account["covered_seconds"] / (entry_end - started))
    mark_coverage = account["complete_mark_checks"] / max(1, account["mark_checks"])
    lower = None
    if len(finished) >= protocol["minimum_completed_distinct_markets"]:
        values = [float(number(x["cash_delta"]) - number(x["stress_cost"])) for x in finished]
        rng = random.Random(protocol["bootstrap_seed"])
        means = sorted(statistics.mean(rng.choices(values, k=len(values)))
                       for _ in range(protocol["bootstrap_samples"]))
        lower = means[int(0.025 * len(means))]
    if not terminal:
        status = "SCREEN_PENDING"
    elif open_games:
        status = "UNRESOLVED_SETTLEMENTS"
    elif (window_coverage < protocol["minimum_coverage"] or mark_coverage < protocol["minimum_coverage"]
          or len(finished) < protocol["minimum_completed_distinct_markets"]):
        status = "INSUFFICIENT_TRADES/COVERAGE"
    elif net <= ZERO or stress <= ZERO or number(account["max_drawdown_usd"]) > number(protocol["maximum_drawdown_fraction"]) * number(protocol["starting_capital_usd"]):
        status = "FAILED_SCREEN"
    elif lower is None or lower <= 0:
        status = "POSITIVE_BUT_UNCERTAIN"
    else:
        status = "PROMISING_SCREEN_ONLY"
    return {"name": account["name"], "wallet": account["wallet"], "status": status,
            "completed_distinct_markets": len(finished), "open_distinct_markets": len(open_games),
            "completed_net_after_modeled_fees_usd": str(net), "completed_stress_net_usd": str(stress),
            "cash_usd": account["cash"], "last_complete_liquidation_equity_usd": account["last_equity"],
            "last_complete_equity_at": account["last_equity_at"],
            "max_observed_drawdown_usd": account["max_drawdown_usd"],
            "drawdown_requires_complete_marks": True, "mark_coverage_fraction": mark_coverage,
            "source_poll_coverage_of_elapsed_collection": coverage,
            "source_poll_coverage_of_planned_collection": window_coverage,
            "last_successful_source_poll": account["last_source_poll"],
            "latest_returned_source_trade": account["last_source_trade"],
            "source_rows_returned_including_overlaps": account["source_rows_returned"],
            "source_poll_failures": account["source_poll_failures"],
            "simulated_contracts_bought": str(sum((number(x["bought"]) for x in account["games"].values()), ZERO)),
            "simulated_contracts_sold": str(sum((number(x["sold"]) for x in account["games"].values()), ZERO)),
            "simulated_contracts_settled": str(sum((number(x["settled"]) for x in account["games"].values()), ZERO)),
            "modeled_fees_usd": str(sum((number(x["fees"]) for x in account["games"].values()), ZERO)),
            "quote_attempts": account["quote_attempts"], "quote_failures": account["quote_failures"],
            "skips_by_reason": account["skips"], "event_cluster_bootstrap_stress_mean_lower_2_5pct": lower,
            "bootstrap_does_not_model_cross_game_or_day_dependence": True}
