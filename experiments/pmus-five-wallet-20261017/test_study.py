import copy
import json
import lzma
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from collector import Collector, allowed, pages, summary
from model import (ONE, ZERO, apply_fill, associate, book, canonical, execute, metrics,
                   new_account, number, settle, sha, verify_account)
from persistence import Journal, Publisher, checkpoint, verify_raw

ROOT = Path(__file__).resolve().parent
P = json.loads((ROOT / "protocol.json").read_text())
FIXTURES = json.loads((ROOT / "mapping_fixtures.json").read_text())


def raw_book(now=None, bid="0.59", ask="0.61", quantity="100"):
    from model import iso
    return {"marketData": {"marketSlug": FIXTURES[0]["us"]["slug"], "state": "MARKET_STATE_OPEN",
                           "transactTime": iso(time.time() if now is None else now),
                           "bids": [{"px": {"value": bid, "currency": "USD"}, "qty": quantity}],
                           "offers": [{"px": {"value": ask, "currency": "USD"}, "qty": quantity}]}}


def state(now=None):
    now = time.time() if now is None else now
    return {"study_id": P["study_id"], "code_sha": "a" * 40,
            "protocol_sha256": sha((ROOT / "protocol.json").read_bytes()), "started_at": now - 60,
            "entry_end": now + 172740, "hard_stop": now + 345540, "last_cycle_at": now,
            "checkpoint_number": 0, "segment": -1, "segment_complete": True,
            "terminal": False, "fatal_error": None, "raw_hash": "0" * 64, "raw_seq": 0,
            "raw_uncompressed_bytes": 0, "raw_compressed_bytes": 0, "http_calls": 0,
            "http_errors": 0, "cycles": 0, "mappings": {}, "accounts": {}, "health": {}}


class AccountingAndAssociation(unittest.TestCase):
    def setUp(self):
        self.m = associate(FIXTURES[0]["source"], FIXTURES[0]["us"], P)
        self.a = new_account("test", "0xunit", "1000")

    def test_four_captured_outcome_joins_and_scheduled_times(self):
        for f in FIXTURES:
            m = associate(f["source"], f["us"], P)
            self.assertEqual(len({s["us_side_id"] for s in m["sides"]}), 2)
            self.assertFalse(m["exact_approved"])
            self.assertEqual(m["quantity_step"], "0.01")

    def test_wrong_start_and_nonbijective_sides_rejected(self):
        bad = copy.deepcopy(FIXTURES[0]["us"])
        bad["gameStartTime"] = "2026-10-19T20:25:00Z"
        with self.assertRaisesRegex(ValueError, "scheduled_time"):
            associate(FIXTURES[0]["source"], bad, P)
        bad = copy.deepcopy(FIXTURES[0]["us"])
        bad["marketSides"][1]["description"] = "Chargers"
        with self.assertRaises(ValueError):
            associate(FIXTURES[0]["source"], bad, P)

    def test_fee_and_quantity_metadata_drift_rejected(self):
        for field, value in [("feeCoefficient", "0.1"), ("minimumTradeQty", "0.0001")]:
            bad = copy.deepcopy(FIXTURES[0]["us"])
            bad[field] = value
            with self.assertRaises(ValueError):
                associate(FIXTURES[0]["source"], bad, P)

    def test_opposite_side_buy_and_sell_use_complementary_depth(self):
        b = book(raw_book(), self.m["us_slug"], time.time(), 60)
        self.assertEqual(number(execute(b, False, "BUY", 10, "0.0695")["average_price"]), number("0.41"))
        self.assertEqual(number(execute(b, False, "SELL", 10, "0.0695")["average_price"]), number("0.39"))

    def test_stale_future_crossed_and_missing_timestamps_rejected(self):
        for b in [raw_book(time.time() - 61), raw_book(time.time() + 6), raw_book(bid="0.7", ask="0.6")]:
            with self.assertRaises(ValueError):
                book(b, self.m["us_slug"], time.time(), 60)
        b = raw_book()
        del b["marketData"]["transactTime"]
        with self.assertRaises(ValueError):
            book(b, self.m["us_slug"], time.time(), 60)

    def test_depth_failure_cannot_mutate_account(self):
        b = book(raw_book(quantity="9"), self.m["us_slug"], time.time(), 60)
        before = canonical(self.a)
        with self.assertRaisesRegex(ValueError, "depth"):
            execute(b, True, "BUY", 10, "0.0695")
        self.assertEqual(canonical(self.a), before)

    def test_documented_fee_example_and_half_even(self):
        b = book(raw_book(bid="0.64", ask="0.65", quantity="1000"), self.m["us_slug"], time.time(), 60)
        self.assertEqual(execute(b, True, "BUY", 1000, "0.0695")["fee"], "15.81")
        b = book(raw_book(bid="0.49", ask="0.50", quantity="1000"), self.m["us_slug"], time.time(), 60)
        self.assertEqual(execute(b, True, "BUY", 100, "0.0695")["fee"], "1.74")

    def test_partial_exit_roundtrip_cash_stress_and_independent_replay(self):
        c = self.m["condition"]
        b = book(raw_book(bid="0.59", ask="0.60"), self.m["us_slug"], time.time(), 60)
        apply_fill(self.a, c, self.m, 0, "BUY", execute(b, True, "BUY", 10, ".0695"), time.time(), ".01")
        b = book(raw_book(bid="0.70", ask="0.71"), self.m["us_slug"], time.time(), 60)
        for q in (4, 6):
            apply_fill(self.a, c, self.m, 0, "SELL", execute(b, True, "SELL", q, ".0695"), time.time(), ".01")
        self.assertTrue(verify_account(self.a, "1000"))
        self.assertEqual(number(self.a["cash"]), number("1000.68"))
        self.assertEqual(number(self.a["games"][self.m["us_slug"]]["stress_cost"]), number("0.20"))
        self.a["cash"] = "1001"
        with self.assertRaisesRegex(ValueError, "cash_mismatch"):
            verify_account(self.a, "1000")

    def test_oversell_rejected_before_cash_mutation(self):
        b = book(raw_book(), self.m["us_slug"], time.time(), 60)
        apply_fill(self.a, self.m["condition"], self.m, 0, "BUY", execute(b, True, "BUY", 2, ".0695"), time.time(), ".01")
        before = self.a["cash"]
        with self.assertRaisesRegex(ValueError, "oversell"):
            apply_fill(self.a, self.m["condition"], self.m, 0, "SELL", execute(b, True, "SELL", 3, ".0695"), time.time(), ".01")
        self.assertEqual(before, self.a["cash"])

    def test_nonbinary_us_settlement_and_opposite_orientation(self):
        b = book(raw_book(bid="0.69", ask="0.70"), self.m["us_slug"], time.time(), 60)
        apply_fill(self.a, self.m["condition"], self.m, 1, "BUY", execute(b, False, "BUY", 10, ".0695"), time.time(), ".01")
        settle(self.a, self.m["condition"], self.m, ".25", time.time())
        self.assertEqual(self.a["ledger"][-1]["settlement_price"], "0.75")
        self.assertEqual(self.a["ledger"][-1]["fee"], "0")
        self.assertTrue(verify_account(self.a, "1000"))

    def test_accounts_do_not_share_capital(self):
        other = new_account("other", "0xother", "1000")
        self.a["cash"] = "999"
        self.assertEqual(other["cash"], "1000")


class CollectorBehavior(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.s = state()
        self.c = Collector(self.s, P, self.temp.name)
        self.m = associate(FIXTURES[0]["source"], FIXTURES[0]["us"], P)
        self.condition = self.m["condition"]
        self.s["mappings"][self.condition] = self.m
        self.a = new_account("test", "0xunit", "1000")
        self.s["accounts"]["0xunit"] = self.a
        self.target = copy.deepcopy(FIXTURES[0]["us"])
        self.source = copy.deepcopy(FIXTURES[0]["source"])
        self.c.us_market = lambda *args, **kw: self.target
        self.c.source_market = lambda *args, **kw: self.source
        self.c.current_book = lambda slug: book(raw_book(), slug, time.time(), 60)
        self.inventory = {}
        self.c.source_positions = lambda *args: self.inventory

    def tearDown(self):
        self.c.journal.file.close()
        self.temp.cleanup()

    def signal(self):
        now = time.time()
        return {"first_seen": now - 10, "latest_at": now - 10,
                "rows": [{"side": "BUY", "token_id": self.m["sides"][0]["token"],
                          "timestamp": now - 10, "price": .60, "size": 100}]}

    def holdings(self, amount):
        self.inventory = {(self.condition, self.m["sides"][0]["token"]): {
            "current_size": amount, "last_event_at": time.time(), "redeemable": False}}

    def test_new_buy_consumed_once_and_net_reductions_followed(self):
        self.a["pending"][self.condition] = self.signal()
        self.holdings(100)
        self.c.service_account(self.a)
        self.assertEqual(number(self.a["positions"][self.condition]["quantity"]), number(10))
        self.assertNotIn(self.condition, self.a["pending"])
        self.c.service_account(self.a)
        self.assertEqual(len(self.a["ledger"]), 1)
        self.holdings(50)
        self.c.service_account(self.a)
        self.assertEqual(number(self.a["positions"][self.condition]["quantity"]), number(5))
        self.holdings(0)
        self.c.service_account(self.a)
        self.assertEqual(number(self.a["positions"][self.condition]["quantity"]), ZERO)
        self.assertTrue(verify_account(self.a, "1000"))

    def test_old_fill_never_becomes_new_entry(self):
        row = {"timestamp": self.s["started_at"] - 1}
        self.c.observe_feed(self.a, [row], time.time(), int(time.time()))
        self.assertFalse(self.a["pending"])
        self.assertFalse(self.a["ledger"])

    def test_inventory_index_lag_blocks_entry(self):
        self.a["pending"][self.condition] = self.signal()
        self.holdings(100)
        next(iter(self.inventory.values()))["last_event_at"] = self.s["started_at"] - 10
        self.c.service_account(self.a)
        self.assertFalse(self.a["ledger"])
        self.assertIn("source_inventory_lags_signal", self.a["skips"])

    def test_foreign_resolution_never_settles_or_sells_us_position(self):
        self.a["pending"][self.condition] = self.signal()
        self.holdings(100)
        self.c.service_account(self.a)
        self.source["closed"] = True
        self.inventory = {}
        self.c.service_account(self.a)
        self.assertEqual(len(self.a["ledger"]), 1)
        self.assertEqual(number(self.a["positions"][self.condition]["quantity"]), number(10))

    def test_empty_open_inventory_without_closed_confirmation_preserved(self):
        self.a["pending"][self.condition] = self.signal()
        self.holdings(100)
        self.c.service_account(self.a)
        self.inventory = {}
        self.c.net.get = lambda url: ({"data": [], "pagination": {"has_more": False}}, time.time())
        self.c.service_account(self.a)
        self.assertEqual(number(self.a["positions"][self.condition]["quantity"]), number(10))
        self.assertIn("empty_source_inventory_without_closed_position_confirmation", self.a["skips"])

    def test_wrong_us_settlement_slug_cannot_close_position(self):
        self.a["pending"][self.condition] = self.signal()
        self.holdings(100)
        self.c.service_account(self.a)
        self.target.update(status="MARKET_STATUS_RESOLVED", closed=True)
        self.c.net.get = lambda url: ({"slug": "wrong", "settlement": 1}, time.time())
        self.c.service_account(self.a)
        self.assertEqual(number(self.a["positions"][self.condition]["quantity"]), number(10))

    def test_full_pagination_retains_anchor_and_filter(self):
        urls = []
        wallet = "0xunit"
        def get(url):
            urls.append(url)
            return ({"data": [{"proxy_wallet": wallet, "condition_id": "c"}],
                     "pagination": {"has_more": len(urls) == 1, "next_cursor": "cursor" if len(urls) == 1 else None}}, time.time())
        self.c.net.get = get
        rows, _ = pages(self.c.net, "https://data-api.polymarket.com/v2/positions", {"user": wallet, "condition": "c", "status": "OPEN"}, wallet, {"c"})
        self.assertEqual(len(rows), 2)
        self.assertIn("user=0xunit", urls[1])
        self.assertIn("condition=c", urls[1])
        self.assertIn("cursor=cursor", urls[1])

    def test_incomplete_pagination_cannot_be_used_as_complete_inventory(self):
        self.c.net.get = lambda url: ({"data": [], "pagination": {"has_more": True, "next_cursor": "same"}}, time.time())
        with self.assertRaisesRegex(ValueError, "pagination"):
            pages(self.c.net, "https://data-api.polymarket.com/v2/positions", {"user": "0xunit"}, "0xunit")


class CheckpointAndStatuses(unittest.TestCase):
    def test_evidence_tampering_and_checkpoint_identity_change_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            s = state()
            j = Journal(directory, s)
            j.add("sample", {"x": 1})
            files, manifest = checkpoint(s, P, j, {}, Path(directory) / "out")
            self.assertTrue(verify_raw(files[manifest["raw_path"]], manifest))
            lines = lzma.decompress(files[manifest["raw_path"]]).splitlines()
            row = json.loads(lines[0]); row["payload"]["x"] = 2
            changed = lzma.compress(canonical(row) + b"\n" + b"\n".join(lines[1:]) + b"\n")
            with self.assertRaises(ValueError):
                verify_raw(changed, manifest)
            with patch.dict("os.environ", {"GH_TOKEN": "unit-test-only"}):
                publisher = Publisher(P, "a" * 40)
            publisher.ref = lambda: {"object": {"sha": "b" * 40}}
            publisher.content = lambda path: files[path]
            with self.assertRaisesRegex(ValueError, "identity"):
                publisher.load(-1, "wrong-protocol")

    def test_terminal_status_precedence_and_no_partial_window_success(self):
        a = new_account("test", "0xunit", "1000")
        a["mark_checks"] = a["complete_mark_checks"] = 1
        a["covered_seconds"] = 172800
        for i in range(30):
            a["games"][str(i)] = {"cash_delta": "1", "stress_cost": ".1", "entry_fills": 1,
                                  "bought": "10", "sold": "10", "settled": "0", "fees": ".2"}
        pp = {**P, "bootstrap_samples": 500}
        m = metrics(a, {}, pp, 172800, 0, 172800, True)
        self.assertEqual(m["status"], "PROMISING_SCREEN_ONLY")
        a["covered_seconds"] = 1000
        self.assertEqual(metrics(a, {}, pp, 1000, 0, 172800, True)["status"], "INSUFFICIENT_TRADES/COVERAGE")
        a["covered_seconds"] = 172800
        for g in a["games"].values():
            g["cash_delta"] = "-1"
        self.assertEqual(metrics(a, {}, pp, 172800, 0, 172800, True)["status"], "FAILED_SCREEN")
        a["positions"]["open"] = {"quantity": "1"}
        self.assertEqual(metrics(a, {"open": {"us_slug": "x"}}, pp, 172800, 0, 172800, True)["status"], "UNRESOLVED_SETTLEMENTS")

    def test_private_and_order_endpoints_outside_venue_get_allowlist(self):
        for url in ["https://clob.polymarket.com/order", "https://gateway.polymarket.us/v1/orders",
                    "https://data-api.polymarket.com/v2/activity", "https://evil.test/v2/trades",
                    "https://x@gamma-api.polymarket.com/markets"]:
            self.assertFalse(allowed(url), url)
        self.assertTrue(allowed("https://data-api.polymarket.com/v2/trades?user=x"))


if __name__ == "__main__":
    unittest.main()
