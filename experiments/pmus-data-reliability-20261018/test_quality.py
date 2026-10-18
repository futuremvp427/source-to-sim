import copy
import contextlib
import datetime as dt
import io
import json
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

from quality import compare_stream, inspect_book, readiness, resolve_catalog, transport
from probe import Journal, allowed, capture_cycle, catalog, main, refresh_matches, resolve_sources, verify_journal

NOW = 1792340000.0
SLUG = "aec-nfl-ari-lar-2026-10-18"
CONDITION = "0x" + "a" * 64


def iso(at):
    return dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat()


def response(body=None, at=NOW, age="0"):
    headers = {"date": dt.datetime.fromtimestamp(at, dt.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")}
    if age is not None:
        headers["age"] = age
    return {"status": 200, "error": None, "headers": headers, "received_at": at,
            "body": body if body is not None else {"marketData": {"marketSlug": SLUG,
                "state": "MARKET_STATE_OPEN", "transactTime": iso(at - 1),
                "bids": [{"px": {"value": ".4", "currency": "USD"}, "qty": "20"}],
                "offers": [{"px": {"value": ".6", "currency": "USD"}, "qty": "20"}]}},
            "evidence": {"seq": 1, "hash": "example"}}


def source():
    return {"conditionId": CONDITION, "slug": "nfl-ari-la-2026-10-18", "sportsMarketType": "moneyline",
            "gameStartTime": iso(NOW + 1000), "description": "SYNTHETIC SOURCE RULES",
            "outcomes": json.dumps(["Cardinals", "Rams"]), "clobTokenIds": json.dumps(["one", "two"])}


def target(slug=SLUG):
    return {"id": slug, "slug": slug, "category": "sports", "marketType": "moneyline",
            "sportsMarketType": "nfl_full_game_winner", "active": True, "closed": False,
            "status": "MARKET_STATUS_OPEN", "gameStartTime": iso(NOW + 1000),
            "description": "SYNTHETIC US RULES WITH DIFFERENT CONTINGENCIES", "feeCoefficient": ".0695",
            "minimumTradeQty": ".01", "marketSides": [
                {"id": "1", "long": True, "tradable": True, "description": "Cardinals",
                 "team": {"name": "Cardinals", "league": "nfl"}},
                {"id": "2", "long": False, "tradable": True, "description": "Rams",
                 "team": {"name": "Rams", "league": "nfl"}}]}


class FakeClient:
    def __init__(self, rows):
        self.rows, self.calls = rows, []

    def get(self, url):
        self.calls.append(url)
        value = self.rows(url) if callable(self.rows) else self.rows[len(self.calls) - 1]
        return copy.deepcopy(value)


class QualityTests(unittest.TestCase):
    def test_good_book_has_real_depth(self):
        x = inspect_book(response(), SLUG)
        self.assertTrue(x["usable"])
        self.assertEqual(x["sell_depth_diagnostics"]["long"]["quantity"], "10")

    def test_fresh_date_does_not_override_old_age(self):
        x = inspect_book(response(age="29"), SLUG)
        self.assertFalse(x["usable"])
        self.assertIn("stale_http_cache", x["issues"])
        self.assertLess(x["http_date_age_seconds"], 1)

    def test_old_book_rejected_with_fresh_transport(self):
        r = response()
        r["body"]["marketData"]["transactTime"] = iso(NOW - 100)
        self.assertIn("stale_or_future_book", inspect_book(r, SLUG)["issues"])

    def test_all_known_reasons_retained(self):
        r = response(age="30")
        r["body"]["marketData"]["transactTime"] = iso(NOW - 100)
        x = inspect_book(r, SLUG)
        self.assertIn("stale_http_cache", x["issues"])
        self.assertIn("stale_or_future_book", x["issues"])

    def test_future_book_rejected(self):
        r = response()
        r["body"]["marketData"]["transactTime"] = iso(NOW + 10)
        self.assertFalse(inspect_book(r, SLUG)["usable"])

    def test_invalid_age_is_not_zero(self):
        for age in ("NaN", "-1", "bad"):
            self.assertIn("invalid_http_age", transport(response(age=age))[0])

    def test_missing_age_is_explicit(self):
        x = inspect_book(response(age=None), SLUG)
        self.assertTrue(x["usable"])
        self.assertFalse(x["age_header_present"])

    def test_missing_date_fails(self):
        r = response()
        r["headers"] = {}
        self.assertFalse(inspect_book(r, SLUG)["usable"])

    def test_failed_http_cannot_be_flat_value(self):
        r = response()
        r.update(status=500, error="HTTP_500")
        self.assertFalse(inspect_book(r, SLUG)["usable"])

    def test_partial_depth_is_not_full_fill(self):
        r = response()
        r["body"]["marketData"]["bids"][0]["qty"] = "1"
        self.assertIn("long_insufficient_full_quantity_depth", inspect_book(r, SLUG)["issues"])

    def test_one_sided_book_fails(self):
        r = response()
        r["body"]["marketData"]["offers"] = []
        self.assertFalse(inspect_book(r, SLUG)["usable"])

    def test_wrong_identity_fails(self):
        self.assertFalse(inspect_book(response(), "aec-other-market")["usable"])

    def test_catalog_does_not_guess_slug(self):
        x = resolve_catalog(source(), [target("aec-nfl-different-actual-catalog-name")], True)
        self.assertEqual(x["status"], "matched")
        self.assertEqual(x["mapping"]["us_slug"], "aec-nfl-different-actual-catalog-name")
        self.assertIs(x["mapping"]["exact_approved"], False)

    def test_ambiguous_catalog_fails(self):
        self.assertEqual(resolve_catalog(source(), [target(), target("aec-duplicate")], True)["status"], "ambiguous_catalog_match")

    def test_wrong_scheduled_time_fails(self):
        t = target()
        t["gameStartTime"] = iso(NOW + 1001)
        self.assertIsNone(resolve_catalog(source(), [t], True)["mapping"])

    def test_incomplete_catalog_cannot_be_no_opportunity(self):
        self.assertEqual(resolve_catalog(source(), [target()], False)["status"], "catalog_incomplete")

    def test_nontradable_catalog_fails(self):
        t = target()
        t["marketSides"][0]["tradable"] = False
        self.assertIsNone(resolve_catalog(source(), [t], True)["mapping"])

    def test_one_failure_does_not_skip_other_market(self):
        x = resolve_catalog(source(), [target()], True)
        y = copy.deepcopy(x)
        y["mapping"]["us_slug"] = "aec-second-market"
        def answer(url):
            slug = url.split("/")[-2]
            r = response(age="30" if slug == SLUG else "0")
            r["body"]["marketData"]["marketSlug"] = slug
            return r
        client = FakeClient(answer)
        r = capture_cycle(client, {"a": x, "b": y}, 0, NOW)
        self.assertEqual(len(client.calls), 2)
        self.assertFalse(r["markets"]["a"]["usable"])
        self.assertTrue(r["markets"]["b"]["usable"])

    def test_late_sample_does_not_fill_missed_slot(self):
        x = resolve_catalog(source(), [target()], True)
        client = FakeClient([response(at=NOW + 21)])
        r = capture_cycle(client, {"a": x}, 0, NOW)
        self.assertIn("outside_scheduled_observation_slot", r["markets"]["a"]["issues"])

    def test_catalog_keeps_paging_until_empty(self):
        client = FakeClient([response({"markets": [target()]}), response({"markets": []})])
        self.assertTrue(catalog(client)["complete"])
        self.assertEqual(len(client.calls), 2)

    def test_nonadvancing_catalog_rejected(self):
        client = FakeClient([response({"markets": [target()]})] * 3)
        self.assertFalse(catalog(client)["complete"])

    def test_catalog_size_bound_is_not_complete(self):
        client = FakeClient([response({"markets": [target()]})])
        self.assertFalse(catalog(client, max_pages=1)["complete"])

    def test_incomplete_catalog_does_not_probe_foreign_guesses(self):
        client = FakeClient([])
        result = resolve_sources(client, [CONDITION], {"complete": False, "markets": [], "issues": ["partial"]})
        self.assertEqual(result[CONDITION]["status"], "catalog_incomplete")
        self.assertEqual(client.calls, [])

    def test_catalog_observed_slug_can_supply_missing_details(self):
        partial = target("aec-real-catalog-slug")
        partial.pop("minimumTradeQty")
        client = FakeClient([response([source()]), response({"market": target("aec-real-catalog-slug")})])
        result = resolve_sources(client, [CONDITION], {"complete": True, "markets": [partial], "issues": []})
        self.assertEqual(result[CONDITION]["status"], "matched")
        self.assertTrue(client.calls[1].endswith("/v1/market/slug/aec-real-catalog-slug"))

    def test_no_private_or_order_endpoint(self):
        for u in ("https://api.polymarket.us/v1/orders", "https://gateway.polymarket.us/v1/orders",
                  "https://user:secret@gateway.polymarket.us/v1/markets", "http://gateway.polymarket.us/v1/markets",
                  "https://gateway.polymarket.us:443/v1/markets", "https://gateway.polymarket.us/v1/markets#bad"):
            self.assertFalse(allowed(u))
        self.assertTrue(allowed("https://gateway.polymarket.us/v1/markets/" + SLUG + "/book"))

    def test_journal_chain(self):
        with tempfile.TemporaryDirectory() as t:
            j = Journal(Path(t) / "new")
            j.add("fixture", {"test": True})
            j.close()
            self.assertEqual(verify_journal(j.path)["records"], 1)

    def test_journal_cannot_overwrite_existing(self):
        with tempfile.TemporaryDirectory() as t:
            with self.assertRaises(FileExistsError):
                Journal(t)

    def test_live_network_requires_explicit_disclosure_approval(self):
        args = ["probe.py", "--watchlist", "/does-not-exist.json", "--output", "/not-created"]
        with mock.patch("sys.argv", args), mock.patch("probe.PublicClient") as client, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as exc:
                main()
            self.assertEqual(exc.exception.code, 2)
            client.assert_not_called()

    def test_stream_heartbeat_is_not_book(self):
        x = inspect_book(response(), SLUG)
        self.assertFalse(compare_stream(x, {"heartbeat": {}})["matched"])

    def test_decimal_scale_does_not_cause_fake_mismatch(self):
        r = response()
        r["body"]["marketData"]["bids"][0]["px"]["value"] = "0.4000"
        a, b = inspect_book(response(), SLUG), inspect_book(r, SLUG)
        self.assertTrue(compare_stream(a, b)["matched"])
        self.assertFalse(compare_stream(a, b)["proves_authenticated_live_feed"])

    def test_missing_ticks_remain_denominator(self):
        p = {"started_at": NOW, "planned_duration_seconds": 86400, "interval_seconds": 20,
             "matches": {"a": resolve_catalog(source(), [target()], True)}}
        r = readiness(p, [{"tick": 0, "markets": {"a": {"usable": True}}}], NOW + 86400)
        self.assertAlmostEqual(r["markets"]["a"]["coverage_full_planned"], 1 / 4320)
        self.assertFalse(r["ready_for_new_paper_study"])
        self.assertFalse(r["public_observation_gate_passed"])

    def test_short_perfect_smoke_is_not_full_soak(self):
        p = {"started_at": NOW, "planned_duration_seconds": 86400, "interval_seconds": 20,
             "matches": {"a": resolve_catalog(source(), [target()], True)}}
        r = readiness(p, [{"tick": 0, "markets": {"a": {"usable": True}}}], NOW + 20)
        self.assertEqual(r["markets"]["a"]["coverage_elapsed"], 1)
        self.assertFalse(r["public_observation_gate_passed"])

    def test_duplicate_ticks_rejected(self):
        p = {"started_at": NOW, "planned_duration_seconds": 86400, "interval_seconds": 20, "matches": {}}
        with self.assertRaises(ValueError):
            readiness(p, [{"tick": 0}, {"tick": 0}], NOW + 20)

    def test_official_settlement_not_counted_as_book(self):
        p = {"started_at": NOW, "planned_duration_seconds": 86400, "interval_seconds": 20,
             "matches": {"a": resolve_catalog(source(), [target()], True)}}
        r = readiness(p, [{"tick": 0, "markets": {"a": {"usable": True, "kind": "official_us_settlement"}}}], NOW + 20)
        self.assertEqual(r["markets"]["a"]["official_us_settlement_ticks"], 1)
        self.assertEqual(r["markets"]["a"]["valid_book_ticks"], 0)

    def test_perfect_full_public_window_does_not_unlock_stream_gate(self):
        p = {"started_at": NOW, "planned_duration_seconds": 86400, "interval_seconds": 20,
             "matches": {"a": resolve_catalog(source(), [target()], True)}}
        rows = [{"tick": t, "markets": {"a": {"usable": True, "kind": "book"}}} for t in range(4320)]
        r = readiness(p, rows, NOW + 86400)
        self.assertTrue(r["public_observation_gate_passed"])
        self.assertFalse(r["ready_for_new_paper_study"])

    def test_high_overall_coverage_does_not_hide_bad_phase(self):
        p = {"started_at": NOW, "planned_duration_seconds": 86400, "interval_seconds": 20,
             "matches": {"a": resolve_catalog(source(), [target()], True)}}
        rows = [{"tick": t, "markets": {"a": {"usable": t >= 50, "kind": "book"}}} for t in range(4320)]
        r = readiness(p, rows, NOW + 86400)
        self.assertGreater(r["markets"]["a"]["coverage_elapsed"], .95)
        self.assertFalse(r["public_observation_gate_passed"])


if __name__ == "__main__":
    unittest.main()
