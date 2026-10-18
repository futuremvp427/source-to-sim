import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from collector import Collector, destination_slugs
from model import associate, new_account
from persistence import Publisher
from test_study import state

ROOT = Path(__file__).resolve().parent
P = json.loads((ROOT / "protocol.json").read_text())
FIXTURES = json.loads((ROOT / "additional_mapping_fixtures.json").read_text())


class FourWalletLookup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = state()
        self.c = Collector(self.s, P, self.tmp.name)

    def tearDown(self):
        self.c.journal.file.close()
        self.tmp.cleanup()

    def test_four_wallet_identity_and_capital(self):
        self.assertEqual([w["name"] for w in P["wallets"]],
                         ["ic4cream", "alwaysfade", "monkeymashingkeyboard", "para-Vision"])
        self.assertEqual(len({w["address"] for w in P["wallets"]}), 4)
        for w in P["wallets"]:
            a = new_account(w["name"], w["address"], P["starting_capital_usd"])
            self.assertEqual(a["cash"], "1000")
            self.assertFalse(a["positions"])
            self.assertFalse(a["ledger"])
        self.assertEqual(P["maximum_contracts_per_market"], "10")
        self.assertFalse(P["live_trading"])
        self.assertFalse(P["venue_credentials"])

    def test_captured_sides_and_kickoffs_still_required(self):
        for fixture in FIXTURES:
            m = associate(fixture["source"], fixture["us"], P)
            self.assertFalse(m["exact_approved"])
            self.assertEqual(len({s["us_side_id"] for s in m["sides"]}), 2)
            self.assertEqual(m["us_slug"], fixture["us"]["slug"])

    def test_only_two_reviewed_calendar_candidates(self):
        source = FIXTURES[1]["source"]
        self.assertEqual(destination_slugs(source, P),
                         ["aec-nfl-dal-gb-2026-10-19", "aec-nfl-dal-gb-2026-10-18"])
        self.assertEqual(destination_slugs(FIXTURES[0]["source"], P),
                         ["aec-nfl-car-phi-2026-10-18"])

    def test_reviewed_rams_alias(self):
        self.assertEqual(destination_slugs(FIXTURES[2]["source"], P),
                         ["aec-nfl-ari-lar-2026-10-18"])

    def test_404_calendar_fallback_uses_captured_matching_fixture(self):
        source, target = FIXTURES[1]["source"], FIXTURES[1]["us"]
        self.c.source_market = lambda condition: source
        calls = []
        def us(slug):
            calls.append(slug)
            if slug != target["slug"]:
                raise ValueError("HTTP 404")
            return target
        self.c.us_market = us
        m = self.c.mapping(source["conditionId"])
        self.assertEqual(m["us_slug"], target["slug"])
        self.assertEqual(calls, destination_slugs(source, P))
        self.assertFalse(m["exact_approved"])

    def test_rate_limit_does_not_trigger_calendar_retry(self):
        source = FIXTURES[1]["source"]
        self.c.source_market = lambda condition: source
        calls = []
        def us(slug):
            calls.append(slug)
            raise ValueError("HTTP 429")
        self.c.us_market = us
        with self.assertRaisesRegex(ValueError, "429"):
            self.c.mapping(source["conditionId"])
        self.assertEqual(len(calls), 1)
        self.assertFalse(self.s["mappings"])

    def test_matching_slug_with_wrong_kickoff_fails_closed(self):
        source = FIXTURES[0]["source"]
        target = copy.deepcopy(FIXTURES[0]["us"])
        target["gameStartTime"] = "2026-10-18T18:00:00Z"
        self.c.source_market = lambda condition: source
        self.c.us_market = lambda slug: target
        with self.assertRaisesRegex(ValueError, "scheduled_time"):
            self.c.mapping(source["conditionId"])
        self.assertFalse(self.s["mappings"])

    def test_publisher_cannot_write_original_study_or_default_branch(self):
        with patch.dict("os.environ", {"GH_TOKEN": "unit-test-only"}):
            self.assertEqual(Publisher(P, "a" * 40).branch, P["state_branch"])
            for branch in ("main", "research/pmus-five-wallet-state-20261017",
                           "research/pmus-four-wallet-state-other"):
                with self.assertRaisesRegex(ValueError, "dedicated"):
                    Publisher({**P, "state_branch": branch}, "a" * 40)


if __name__ == "__main__":
    unittest.main()
