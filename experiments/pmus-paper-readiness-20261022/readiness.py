#!/usr/bin/env python3
"""Fail closed before prospective entries. No network, credentials or trading.

This verifies an independently reviewed evidence packet and local proof hashes.
It does not manufacture evidence or replace inspection of the exact code/run.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def artifact_ok(root, proof):
    if not isinstance(proof, dict) or proof.get("independently_verified") is not True:
        return False
    relative = proof.get("file")
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        return False
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        return False
    expected = proof.get("sha256", "")
    if not isinstance(expected, str) or not HEX64.fullmatch(expected):
        return False
    size = proof.get("bytes")
    if type(size) is not int or size <= 0 or size > 8 * 1024**2:
        return False
    data = path.read_bytes()
    return len(data) == size and digest(data) == expected


def assess(requirements, packet, evidence_root):
    issues = []
    code = packet.get("collector_code_sha", "")
    if not isinstance(code, str) or not HEX40.fullmatch(code):
        issues.append("paper_collector_not_frozen_or_verified")
    protocol = packet.get("paper_protocol_sha256", "")
    if not isinstance(protocol, str) or not HEX64.fullmatch(protocol):
        issues.append("new_paper_protocol_not_frozen")
    if packet.get("reference_protocol_sha256") != requirements["reference_protocol_sha256"]:
        issues.append("reference_protocol_identity_mismatch")
    if packet.get("wallets") != requirements["wallets"]:
        issues.append("wallet_identity_mismatch")
    if packet.get("requirements_sha256") != requirements["requirements_sha256"]:
        issues.append("requirements_identity_mismatch")
    if packet.get("entry_collection_hours") != requirements["entry_collection_hours"] or packet.get(
            "maximum_settlement_drain_hours") != requirements["maximum_settlement_drain_hours"]:
        issues.append("unapproved_horizon_change")
    for name in requirements["required_checks"]:
        check = packet.get("checks", {}).get(name, {})
        if (check.get("status") != "passed" or check.get("code_sha") != code
                or not artifact_ok(evidence_root, check.get("proof"))):
            issues.append("unverified_check:" + name)
    if set(packet.get("final_columns_demonstrated", [])) != set(requirements["required_final_columns"]):
        issues.append("final_evaluation_outputs_not_demonstrated")
    if packet.get("proofs_are_test_fixtures") is not False:
        issues.append("fixture_packet_is_not_live_readiness_evidence")
    live = packet.get("live_gate", {})
    if (live.get("live_gate_passed") is not True or live.get("completed_full_window") is not True
            or live.get("planned_ticks_per_market") != 90
            or type(live.get("actual_elapsed_seconds")) not in (int, float)
            or not math.isfinite(live.get("actual_elapsed_seconds", 0))
            or live.get("actual_elapsed_seconds", 0) < 1800
            or not isinstance(live.get("run_id"), str)
            or not re.fullmatch(r"[0-9]{6,20}", live.get("run_id", ""))
            or not artifact_ok(evidence_root, live.get("proof"))):
        issues.append("actual_live_gate_not_yet_verified")
    markets = live.get("markets", {})
    if set(markets) != set(requirements["live_gate_markets"]):
        issues.append("live_gate_requires_both_frozen_markets")
    for slug, market in markets.items():
        valid = market.get("valid_live_quote_ticks")
        matched = market.get("matched_distinct_book_timestamps")
        if (type(valid) is not int or not 86 <= valid <= 90
                or type(matched) is not int or matched < 3):
            issues.append("live_market_coverage_or_alignment:" + slug)
    source_ticks = live.get("source_valid_ticks", {})
    for wallet in requirements["wallets"].values():
        value = source_ticks.get(wallet)
        if type(value) is not int or not 86 <= value <= 90:
            issues.append("live_source_coverage:" + wallet)
    sample = packet.get("sample_plan", {})
    if (sample.get("independently_reviewed") is not True
            or not artifact_ok(evidence_root, sample.get("proof"))
            or sample.get("forecasts_are_not_guarantees") is not True):
        issues.append("sample_and_settlement_feasibility_not_reviewed")
    for wallet in requirements["wallets"].values():
        estimate = sample.get("conservative_completed_distinct_market_estimates", {}).get(wallet)
        if (type(estimate) not in (int, float) or not math.isfinite(estimate)
                or estimate < requirements["minimum_completed_distinct_markets_per_account"]):
            issues.append("insufficient_or_unknown_sample_plan:" + wallet)
    return {
        "schema": 1,
        "launch_ready": not issues,
        "stage": "READY_FOR_PAPER_ONLY" if not issues else "NOT_READY_FOR_PAPER_ENTRIES",
        "requirements_sha256": requirements["requirements_sha256"],
        "collector_code_sha": packet.get("collector_code_sha"),
        "blockers": issues,
        "profitability_evaluated": False,
        "future_profit_or_sample_size_guaranteed": False,
        "real_orders": 0,
        "private_account_requests": 0
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--expected-requirements-sha256", required=True)
    args = parser.parse_args()
    data = (ROOT / "requirements.json").read_bytes()
    if digest(data) != args.expected_requirements_sha256:
        raise SystemExit("Requirements changed: pre-entry re-review required")
    requirements = json.loads(data)
    requirements["requirements_sha256"] = digest(data)
    try:
        result = assess(requirements, json.loads(args.packet.read_bytes()), args.evidence_root)
    except (ValueError, TypeError, KeyError, AttributeError, OSError) as error:
        print(json.dumps({"launch_ready": False, "stage": "INVALID_EVIDENCE_PACKET",
                          "error_type": type(error).__name__}, sort_keys=True))
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["launch_ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
