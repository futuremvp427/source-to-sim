"""Offline fixtures exercise rejection, not live data or profitability proof."""
import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import readiness


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        # A test-only evidence fixture. Never published as real launch evidence.
        proof_file = self.root / "proof.json"
        proof_file.write_bytes(b'{"unit_test_fixture_only":true}\n')
        proof = {"file": "proof.json", "sha256": readiness.digest(proof_file.read_bytes()),
                 "bytes": proof_file.stat().st_size, "independently_verified": True}
        req_data = (readiness.ROOT / "requirements.json").read_bytes()
        self.requirements = json.loads(req_data)
        self.requirements["requirements_sha256"] = readiness.digest(req_data)
        self.packet = {
            "collector_code_sha": "a" * 40,
            "paper_protocol_sha256": "b" * 64,
            "reference_protocol_sha256": self.requirements["reference_protocol_sha256"],
            "requirements_sha256": readiness.digest(req_data),
            "wallets": self.requirements["wallets"],
            "entry_collection_hours": 48, "maximum_settlement_drain_hours": 48,
            "proofs_are_test_fixtures": False,  # Deliberately varied in rejection tests.
            "final_columns_demonstrated": self.requirements["required_final_columns"],
            "checks": {name: {"status": "passed", "code_sha": "a" * 40, "proof": proof}
                       for name in self.requirements["required_checks"]},
            "live_gate": {"live_gate_passed": True, "completed_full_window": True,
                "actual_elapsed_seconds": 1800, "planned_ticks_per_market": 90,
                "run_id": "12345678901", "proof": proof,
                "markets": {slug: {"valid_live_quote_ticks": 86,
                    "matched_distinct_book_timestamps": 3}
                    for slug in self.requirements["live_gate_markets"]},
                "source_valid_ticks": {wallet: 86 for wallet in self.requirements["wallets"].values()}},
            "sample_plan": {"independently_reviewed": True, "proof": proof,
                "forecasts_are_not_guarantees": True,
                "conservative_completed_distinct_market_estimates": {
                    wallet: 30 for wallet in self.requirements["wallets"].values()}}}

    def tearDown(self):
        self.temp.cleanup()

    def result(self):
        return readiness.assess(self.requirements, self.packet, self.root)

    def test_complete_schema_fixture_exercises_ready_branch_only(self):
        result = self.result()
        self.assertTrue(result["launch_ready"])
        self.assertFalse(result["profitability_evaluated"])
        self.assertFalse(result["future_profit_or_sample_size_guaranteed"])

    def test_empty_packet_fails_closed(self):
        self.assertFalse(readiness.assess(self.requirements, {}, self.root)["launch_ready"])

    def test_every_required_check_is_individually_required(self):
        good = copy.deepcopy(self.packet)
        for name in self.requirements["required_checks"]:
            with self.subTest(name=name):
                self.packet = copy.deepcopy(good)
                del self.packet["checks"][name]
                self.assertIn("unverified_check:" + name, self.result()["blockers"])

    def test_different_collector_code_invalidates_proofs(self):
        self.packet["collector_code_sha"] = "c" * 40
        self.assertFalse(self.result()["launch_ready"])

    def test_new_protocol_must_be_frozen(self):
        del self.packet["paper_protocol_sha256"]
        self.assertIn("new_paper_protocol_not_frozen", self.result()["blockers"])

    def test_reference_wallets_cannot_change(self):
        self.packet["wallets"] = dict(self.packet["wallets"], ic4cream="0x" + "0" * 40)
        self.assertIn("wallet_identity_mismatch", self.result()["blockers"])

    def test_horizon_must_not_silently_change(self):
        self.packet["entry_collection_hours"] = 72
        self.assertIn("unapproved_horizon_change", self.result()["blockers"])

    def test_preflight_is_not_a_live_gate(self):
        self.packet["live_gate"]["live_gate_passed"] = False
        self.packet["live_gate"]["actual_elapsed_seconds"] = 120
        self.assertIn("actual_live_gate_not_yet_verified", self.result()["blockers"])

    def test_85_of_90_is_not_95_percent(self):
        slug = self.requirements["live_gate_markets"][0]
        self.packet["live_gate"]["markets"][slug]["valid_live_quote_ticks"] = 85
        self.assertFalse(self.result()["launch_ready"])

    def test_other_or_finished_game_cannot_replace_frozen_live_game(self):
        markets = self.packet["live_gate"]["markets"]
        markets["aec-other-game"] = markets.pop(self.requirements["live_gate_markets"][0])
        self.assertIn("live_gate_requires_both_frozen_markets", self.result()["blockers"])

    def test_each_source_has_its_own_denominator(self):
        wallet = next(iter(self.requirements["wallets"].values()))
        self.packet["live_gate"]["source_valid_ticks"][wallet] = 85
        self.assertIn("live_source_coverage:" + wallet, self.result()["blockers"])

    def test_original_small_sample_does_not_qualify_new_design(self):
        for wallet, count in zip(self.requirements["wallets"].values(), (0, 3, 8, 4)):
            self.packet["sample_plan"]["conservative_completed_distinct_market_estimates"][wallet] = count
        self.assertEqual(sum(x.startswith("insufficient_or_unknown_sample_plan:")
                             for x in self.result()["blockers"]), 4)

    def test_pooling_four_wallets_does_not_meet_each_wallet_minimum(self):
        estimates = self.packet["sample_plan"]["conservative_completed_distinct_market_estimates"]
        for wallet in estimates:
            estimates[wallet] = 29
        self.assertFalse(self.result()["launch_ready"])

    def test_missing_forecast_is_not_zero_risk_or_a_guarantee(self):
        self.packet["sample_plan"] = {}
        self.assertFalse(self.result()["launch_ready"])

    def test_missing_final_column_blocks_launch(self):
        self.packet["final_columns_demonstrated"] = self.packet["final_columns_demonstrated"][:-1]
        self.assertIn("final_evaluation_outputs_not_demonstrated", self.result()["blockers"])

    def test_test_fixtures_must_not_claim_live_readiness(self):
        self.packet["proofs_are_test_fixtures"] = True
        self.assertIn("fixture_packet_is_not_live_readiness_evidence", self.result()["blockers"])

    def test_tampered_or_missing_proof_fails(self):
        (self.root / "proof.json").write_bytes(b"changed")
        self.assertFalse(self.result()["launch_ready"])

    def test_proof_cannot_escape_evidence_root(self):
        proof = self.packet["checks"][self.requirements["required_checks"][0]]["proof"]
        proof["file"] = "../proof.json"
        self.assertFalse(self.result()["launch_ready"])

    def test_boolean_cannot_impersonate_sample_count(self):
        wallet = next(iter(self.requirements["wallets"].values()))
        self.packet["sample_plan"]["conservative_completed_distinct_market_estimates"][wallet] = True
        self.assertFalse(self.result()["launch_ready"])


class FrozenEvaluatorSmokeTests(unittest.TestCase):
    """Exercise pinned existing accounting, not a simulated claim about wallets."""
    @classmethod
    def setUpClass(cls):
        reference = readiness.ROOT.parent / "pmus-four-wallet-20261018"
        protocol_bytes = (reference / "protocol.json").read_bytes()
        expected = json.loads((readiness.ROOT / "requirements.json").read_bytes())["reference_protocol_sha256"]
        assert hashlib.sha256(protocol_bytes).hexdigest() == expected
        cls.protocol = json.loads(protocol_bytes)
        spec = importlib.util.spec_from_file_location("readiness_pinned_model", reference / "model.py")
        cls.model = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.model)

    def account(self, count=30, profit="1", stress="0.1"):
        account = self.model.new_account("fixture", "fixture-wallet", "1000")
        account.update(covered_seconds=48 * 3600, mark_checks=8640, complete_mark_checks=8640)
        for i in range(count):
            account["games"]["aec-fixture-" + str(i)] = {"cash_delta": profit, "stress_cost": stress,
                "fees": "0.1", "bought": "10", "sold": "0", "settled": "10",
                "entry_fills": 1, "exit_fills": 0}
        return account

    def status(self, account, mappings=None, terminal=True):
        return self.model.metrics(account, mappings or {}, self.protocol,
                                  48 * 3600, 0, 48 * 3600, terminal=terminal)["status"]

    def test_complete_positive_fixture_is_screen_only(self):
        self.assertEqual(self.status(self.account()), "PROMISING_SCREEN_ONLY")

    def test_missing_planned_source_time_cannot_be_erased(self):
        account = self.account()
        account["covered_seconds"] = 40 * 3600
        self.assertEqual(self.status(account), "INSUFFICIENT_TRADES/COVERAGE")

    def test_missing_marks_are_not_flat_profit(self):
        account = self.account()
        account["complete_mark_checks"] = 4000
        self.assertEqual(self.status(account), "INSUFFICIENT_TRADES/COVERAGE")

    def test_29_distinct_events_even_if_positive_are_insufficient(self):
        self.assertEqual(self.status(self.account(count=29)), "INSUFFICIENT_TRADES/COVERAGE")

    def test_cost_stress_can_fail_a_base_positive_fixture(self):
        self.assertEqual(self.status(self.account(profit="0.05", stress="0.1")), "FAILED_SCREEN")

    def test_drawdown_over_200_fails(self):
        account = self.account()
        account["max_drawdown_usd"] = "200.01"
        self.assertEqual(self.status(account), "FAILED_SCREEN")

    def test_open_inventory_takes_precedence(self):
        account = self.account()
        account["positions"]["condition"] = {"side": 0, "quantity": "10"}
        self.assertEqual(self.status(account, {"condition": {"us_slug": "aec-fixture-0"}}),
                         "UNRESOLVED_SETTLEMENTS")

    def test_nonterminal_green_results_are_not_a_final_screen(self):
        self.assertEqual(self.status(self.account(), terminal=False), "SCREEN_PENDING")

    def test_positive_mean_with_uncertain_event_lower_bound_is_uncertain(self):
        account = self.account()
        for i in range(30):
            account["games"]["aec-fixture-" + str(i)]["cash_delta"] = "11" if i < 15 else "-10"
        self.assertEqual(self.status(account), "POSITIVE_BUT_UNCERTAIN")


if __name__ == "__main__":
    unittest.main()
