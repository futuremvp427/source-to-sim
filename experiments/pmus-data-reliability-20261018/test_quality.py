import copy
import contextlib
import datetime as dt
import io
import json
import hashlib
import lzma
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest import mock
from pathlib import Path

from quality import compare_stream, inspect_book, inspect_settlement, metadata_deadline, readiness, resolve_catalog, transport
from probe import Journal, MetadataRefresher, PublicClient, allowed, capture_cycle, catalog, main, raw_body, refresh_matches, resolve_sources, verify_journal

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

    def test_access_denial_blocks_all_subsequent_requests(self):
        with tempfile.TemporaryDirectory() as t:
            j = Journal(Path(t) / "new")
            client = PublicClient(j)
            opener = mock.Mock()
            opener.open.side_effect = urllib.error.HTTPError(
                "https://gateway.polymarket.us/v1/markets", 403, "Forbidden", {}, io.BytesIO(b"{}"))
            with mock.patch("urllib.request.build_opener", return_value=opener):
                for _ in range(2):
                    with self.assertRaises(PermissionError):
                        client.get("https://gateway.polymarket.us/v1/markets")
            j.close()
            self.assertEqual(opener.open.call_count, 1)

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

    def test_old_payload_fingerprint_survives_rejection(self):
        r = response()
        r["body"]["marketData"]["transactTime"] = iso(NOW - 200)
        a = inspect_book(r, SLUG)
        r["received_at"] += 20
        b = inspect_book(r, SLUG)
        self.assertEqual(a["payload_book_fingerprint"], b["payload_book_fingerprint"])
        self.assertEqual(b["book_age_seconds"], 220)
        self.assertFalse(b["usable"])

    def test_receipt_time_never_replaces_venue_time(self):
        r = response(at=NOW + 1000)
        r["body"]["marketData"]["transactTime"] = iso(NOW)
        self.assertEqual(inspect_book(r, SLUG)["book_at"], NOW)
        self.assertFalse(inspect_book(r, SLUG)["usable"])

    def test_metadata_expiry_uses_original_age(self):
        self.assertEqual(metadata_deadline(response(age="250")), NOW + 50)

    def test_expired_mapping_does_not_promote_good_book(self):
        m = resolve_catalog(source(), [target()], True)
        m["metadata_valid_until"] = NOW - 1
        x = capture_cycle(FakeClient([response()]), {"a": m}, 0, NOW)
        self.assertIn("expired_mapping_metadata", x["markets"]["a"]["issues"])
        self.assertFalse(x["markets"]["a"]["usable"])

    def test_expired_book_checks_official_us_settlement(self):
        m = resolve_catalog(source(), [target()], True)
        r = response()
        r["body"]["marketData"]["state"] = "MARKET_STATE_EXPIRED"
        client = FakeClient([r, response({"slug": SLUG, "settlement": "1"})])
        x = capture_cycle(client, {"a": m}, 0, NOW)["markets"]["a"]
        self.assertTrue(x["usable"])
        self.assertEqual(x["kind"], "official_us_settlement")
        self.assertIn("non_open_book_state", x["rejected_book"]["issues"])
        self.assertTrue(client.calls[-1].endswith("/settlement"))

    def test_expired_book_without_settlement_stays_unusable(self):
        m = resolve_catalog(source(), [target()], True)
        r = response()
        r["body"]["marketData"]["state"] = "MARKET_STATE_EXPIRED"
        x = capture_cycle(FakeClient([r, response({"slug": SLUG})]), {"a": m}, 0, NOW)["markets"]["a"]
        self.assertFalse(x["usable"])
        self.assertFalse(x["settlement_check"]["usable"])

    def test_wrong_book_does_not_trigger_terminal_assumption(self):
        m = resolve_catalog(source(), [target()], True)
        r = response()
        r["body"]["marketData"].update(marketSlug="aec-other", state="MARKET_STATE_EXPIRED")
        client = FakeClient([r])
        self.assertFalse(capture_cycle(client, {"a": m}, 0, NOW)["markets"]["a"]["usable"])
        self.assertEqual(len(client.calls), 1)

    def test_settlement_rejects_stale_wrong_slug_and_invalid_numbers(self):
        for body, age in (({"slug": SLUG, "settlement": "1"}, "29"),
                          ({"slug": "aec-other", "settlement": "1"}, "0"),
                          ({"slug": SLUG, "settlement": True}, "0"),
                          ({"slug": SLUG, "settlement": "NaN"}, "0"),
                          ({"slug": SLUG, "settlement": "1.1"}, "0")):
            self.assertFalse(inspect_settlement(response(body, age=age), SLUG)["usable"])

    def test_closed_source_lookup_is_identity_not_us_settlement(self):
        s = source()
        s["closed"] = True
        client = FakeClient([response([s])])
        x = resolve_sources(client, [CONDITION], {"complete": True, "markets": [target()]})[CONDITION]
        self.assertEqual(x["status"], "matched")
        self.assertTrue(x["source_closed"])
        self.assertIn("closed=any", client.calls[0])
        self.assertNotIn("settlement", x)

    def test_closed_filter_is_bounded_to_identifier_lookup(self):
        self.assertTrue(allowed("https://gamma-api.polymarket.com/markets?condition_ids=" + CONDITION + "&closed=any"))
        self.assertFalse(allowed("https://gamma-api.polymarket.com/markets?closed=any"))
        self.assertFalse(allowed("https://gamma-api.polymarket.com/markets?condition_ids=" + CONDITION + "&closed=anything"))

    def test_empty_source_lookup_has_explicit_reason(self):
        x = resolve_sources(FakeClient([response([])]), [CONDITION], {"complete": True, "markets": []})[CONDITION]
        self.assertEqual(x["issues"], ["empty_source_lookup"])

    def test_failed_candidate_detail_blocks_uniqueness_claim(self):
        partial = target()
        partial.pop("minimumTradeQty")
        other = target("aec-second-candidate")
        bad = response({})
        bad.update(status=500, error="HTTP_500")
        x = resolve_sources(FakeClient([response([source()]), bad]), [CONDITION],
                            {"complete": True, "markets": [partial, other]})[CONDITION]
        self.assertIsNone(x["mapping"])
        self.assertEqual(x["status"], "catalog_incomplete")

    def test_slow_background_refresh_does_not_block_book_capture(self):
        entered, release = threading.Event(), threading.Event()
        m = resolve_catalog(source(), [target()], True)
        client = FakeClient([response()])
        client.deadline = None
        with tempfile.TemporaryDirectory() as t:
            j = Journal(Path(t) / "new")
            refresh = MetadataRefresher(client, {"a": m}, j)
            def slow():
                entered.set()
                release.wait(2)
                return {"a": m}
            refresh._refresh = slow
            refresh.next_at = NOW
            try:
                before = time.monotonic()
                current = refresh.poll({"a": m}, NOW)
                self.assertTrue(entered.wait(.2))
                self.assertTrue(capture_cycle(client, current, 0, NOW)["markets"]["a"]["usable"])
                self.assertLess(time.monotonic() - before, .5)
            finally:
                release.set()
                refresh.close()
                j.close()

    def test_non_json_error_is_in_saved_http_record(self):
        with tempfile.TemporaryDirectory() as t:
            j = Journal(Path(t) / "new")
            fake = mock.MagicMock()
            fake.__enter__.return_value = fake
            fake.status, fake.headers = 200, {}
            fake.read.return_value = b"not json"
            opener = mock.Mock()
            opener.open.return_value = fake
            with mock.patch("urllib.request.build_opener", return_value=opener):
                self.assertEqual(PublicClient(j).get("https://gateway.polymarket.us/v1/markets")["error"], "non_json_response")
            j.close()
            with lzma.open(j.path, "rt") as f:
                self.assertEqual(json.loads(next(f))["payload"]["error"], "non_json_response")
            self.assertTrue(verify_journal(j.path)["verified"])

    def test_body_storage_deduplicates_exact_bytes_without_losing_requests(self):
        with tempfile.TemporaryDirectory() as t:
            j = Journal(Path(t) / "new")
            data = b'{"same":"body"}'
            r = {"url": "https://gateway.polymarket.us/v1/markets", "method": "GET", "authenticated": False,
                 "body_bytes": len(data), "body_sha256": hashlib.sha256(data).hexdigest()}
            j.http(r, data)
            j.http(r, data)
            j.close()
            self.assertEqual(len(list((j.root / "bodies").iterdir())), 1)
            self.assertEqual(verify_journal(j.path)["records"], 2)
            with self.assertRaises(ValueError):
                raw_body(j.path, {**r, "body_path": "../not-allowed"})

    def test_body_evidence_cap_fails_closed(self):
        with tempfile.TemporaryDirectory() as t:
            j = Journal(Path(t) / "new", body_limit=1)
            try:
                with self.assertRaisesRegex(RuntimeError, "compressed_body_evidence_limit"):
                    j.http({}, b"example")
                self.assertEqual(j.seq, 0)
            finally:
                j.close()

    def test_corrupt_body_is_detected(self):
        with tempfile.TemporaryDirectory() as t:
            j = Journal(Path(t) / "new")
            data = b"example"
            r = {"url": "https://gateway.polymarket.us/v1/markets", "method": "GET", "authenticated": False,
                 "body_bytes": len(data), "body_sha256": hashlib.sha256(data).hexdigest()}
            j.http(r, data)
            j.close()
            list((j.root / "bodies").iterdir())[0].write_bytes(lzma.compress(b"wrong"))
            with self.assertRaises(ValueError):
                verify_journal(j.path)

    def test_incomplete_bootstrap_is_failure_not_flat_measured_interval(self):
        with tempfile.TemporaryDirectory() as t:
            watch = Path(t) / "watch.json"
            watch.write_text(json.dumps({"source_condition_ids": [CONDITION]}))
            out = Path(t) / "out"
            args = ["probe.py", "--watchlist", str(watch), "--output", str(out), "--approved-public-watchlist-queries"]
            with mock.patch("sys.argv", args), mock.patch("probe.catalog", return_value={
                "complete": False, "markets": [], "issues": ["HTTP_500"]}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(), 1)
            summary = json.loads((out / "summary.json").read_bytes())
            self.assertFalse(summary["bootstrap_completed"])
            self.assertEqual(summary["actual_cycles"], 0)
            self.assertEqual(summary["measured_elapsed_seconds"], 0)
            self.assertIsNotNone(summary["failure"])


if __name__ == "__main__":
    unittest.main()
