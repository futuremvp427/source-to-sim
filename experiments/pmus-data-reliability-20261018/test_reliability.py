import base64
import collections
import contextlib
import copy
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from durable import DurableJournal, atomic_write, decode_rows, restore_events, verify_checkpoints
from publication import GitMirror, PublicationError
from quality import canonical
from reliability_runner import BackgroundMirror, RetryClient, main, market_identity, observe, summarize
from stream_smoke import StreamState, normalize_market_message
from test_quality import NOW, SLUG, FakeClient, response, target


def plan(markets=None, seconds=86400):
    return {"started_at": NOW, "duration_seconds": seconds, "run_id": "123456789",
            "code_sha": "a" * 40, "stream_enabled": False,
            "markets": markets or {SLUG: {"identity": market_identity(target())}}}


class RecoveryTests(unittest.TestCase):
    def test_acknowledged_rows_survive_abrupt_process_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = str(Path(directory) / "new")
            code = "from durable import DurableJournal; import os; j=DurableJournal(" + repr(root) + "); j.add('saved',{'value':42}); os._exit(9)"
            result = subprocess.run([sys.executable, "-c", code], check=False)
            self.assertEqual(result.returncode, 9)
            journal = DurableJournal(root, resume=True)
            self.assertEqual(journal.seq, 1)
            self.assertEqual(journal.rows[0]["payload"], {"value": 42})
            journal.add("restarted", {})
            journal.close()
            self.assertEqual(decode_rows((Path(root) / "events.jsonl").read_bytes())[1], 2)

    def test_sealing_does_not_close_or_rewrite_active_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            j = DurableJournal(Path(d) / "new")
            j.add("one", {})
            j.seal({"value": 1})
            first = (j.root / "checkpoints/000001/raw.jsonl.xz").read_bytes()
            j.add("two", {})
            j.seal({"value": 2})
            self.assertFalse(j.closed)
            self.assertEqual((j.root / "checkpoints/000001/raw.jsonl.xz").read_bytes(), first)
            self.assertEqual(verify_checkpoints(j.root)["seq"], 2)
            j.close()

    def test_resume_never_overwrites_or_hides_a_partial_tail(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "new"
            j = DurableJournal(root); j.add("one", {}); j.close()
            with (root / "events.jsonl").open("ab") as f:
                f.write(b'{"incomplete":')
            before = (root / "events.jsonl").read_bytes()
            with self.assertRaisesRegex(ValueError, "partial_journal_tail"):
                DurableJournal(root, resume=True)
            self.assertEqual((root / "events.jsonl").read_bytes(), before)

    def test_corruption_in_sealed_evidence_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            j = DurableJournal(Path(d) / "new"); j.add("one", {}); j.seal({}); j.close()
            (j.root / "checkpoints/000001/summary.json").write_text("tampered")
            with self.assertRaisesRegex(ValueError, "digest_mismatch"):
                DurableJournal(j.root, resume=True)

    def test_published_chunks_can_restore_only_an_absent_wal(self):
        with tempfile.TemporaryDirectory() as d:
            j = DurableJournal(Path(d) / "new"); j.add("one", {}); j.seal({}); j.close()
            raw = j.path.read_bytes(); j.path.unlink()
            self.assertEqual(restore_events(j.root)["seq"], 1)
            self.assertEqual(j.path.read_bytes(), raw)
            with self.assertRaisesRegex(ValueError, "refusing_to_overwrite"):
                restore_events(j.root)

    def test_http_raw_bytes_survive_and_are_reverified_on_resume(self):
        with tempfile.TemporaryDirectory() as d:
            j = DurableJournal(Path(d) / "new")
            body = b'{"data":1}'
            record = {"body_sha256": hashlib.sha256(body).hexdigest(), "body_bytes": len(body),
                      "method": "GET", "authenticated": False,
                      "url": "https://gateway.polymarket.us/v1/markets/" + SLUG + "/book"}
            j.http(record, body); j.close()
            restored = DurableJournal(j.root, resume=True)
            self.assertEqual(restored.seq, 1)
            restored.close()
            next((j.root / "bodies").glob("*.xz")).write_bytes(b"bad")
            with self.assertRaises(Exception): DurableJournal(j.root, resume=True)

    def test_evidence_bound_rejects_before_acknowledging_row(self):
        with tempfile.TemporaryDirectory() as d:
            j = DurableJournal(Path(d) / "new", evidence_limit=1)
            with self.assertRaisesRegex(RuntimeError, "evidence_limit"):
                j.add("one", {})
            self.assertEqual(j.seq, 0); self.assertEqual(j.path.stat().st_size, 0); j.close()

    def test_immutable_files_are_not_silently_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x"; atomic_write(p, b"one", immutable=True)
            with self.assertRaisesRegex(ValueError, "immutable"):
                atomic_write(p, b"two", immutable=True)
            self.assertEqual(p.read_bytes(), b"one")


class QualityRecoveryTests(unittest.TestCase):
    def test_complete_runner_resumes_without_replaying_missed_slots(self):
        class Clock:
            now = NOW
            def time(self): return self.now
        clock = Clock()
        class Event:
            def set(self): pass
            def wait(self, seconds): clock.now += max(0, seconds); return False
        class Pool:
            def __init__(self, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def submit(self, function, *args):
                from concurrent.futures import Future
                future = Future()
                try:
                    future.set_result(function(*args))
                except Exception as exc:
                    future.set_exception(exc)
                return future
        def get(url):
            value = response({"market": target()}, at=clock.now) if "/market/slug/" in url else response(at=clock.now)
            value["sent_at"] = clock.now - .1
            return value
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "new"; watch = Path(d) / "watch.json"
            watch.write_bytes(canonical(plan()))
            common = ["--output", str(root), "--watch-plan", str(watch), "--run-id", "123456789",
                      "--code-sha", "a" * 40, "--duration-seconds", "86400", "--approved-data-only"]
            with mock.patch("reliability_runner.PublicClient") as client, mock.patch("reliability_runner.time.time", side_effect=clock.time), mock.patch("reliability_runner.threading.Event", Event), mock.patch("reliability_runner.concurrent.futures.ThreadPoolExecutor", Pool), contextlib.redirect_stdout(io.StringIO()):
                client.return_value.get.side_effect = get
                self.assertEqual(main([*common, "--segment-seconds", "60"]), 0)
                clock.now = NOW + 100  # A lost runner and setup leave two slots unobserved.
                self.assertEqual(main([*common, "--segment-seconds", "20", "--resume"]), 0)
            rows, _, _ = decode_rows((root / "events.jsonl").read_bytes())
            ticks = [r["payload"]["tick"] for r in rows if r["kind"] == "cycle"]
            self.assertEqual(ticks, [0, 1, 2, 5])
            saved = json.loads((root / "summary.json").read_bytes())
            self.assertEqual(saved["started_at"], NOW)
            self.assertEqual(saved["markets"][SLUG]["problems"]["missing_scheduled_observation"], 2)
            self.assertFalse(saved["data_gate_passed"])

    def test_missing_resume_plan_cannot_silently_start_a_new_epoch(self):
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(io.StringIO()):
            root = Path(d) / "missing"
            code = main(["--output", str(root), "--run-id", "123456789", "--code-sha", "a" * 40,
                         "--segment-seconds", "20", "--resume", "--approved-data-only"])
            self.assertEqual(code, 1)
            self.assertFalse((root / "plan.json").exists())
            saved = json.loads((root / "summary.json").read_bytes())
            self.assertFalse(saved["bootstrap_completed"])
            self.assertEqual(saved["actual_cycles"], 0)

    def test_missed_slots_are_in_elapsed_and_full_window_denominators(self):
        rows = [{"kind": "cycle", "payload": {"tick": tick, "markets": {SLUG: {"usable": True}}}}
                for tick in (0, 3)]
        value = summarize(plan(), rows, NOW + 100)["markets"][SLUG]
        self.assertEqual(value["expected_elapsed_ticks"], 5)
        self.assertEqual(value["coverage_elapsed"], .4)
        self.assertEqual(value["coverage_full_planned"], 2 / 4320)
        self.assertEqual(value["problems"]["missing_scheduled_observation"], 3)

    def test_duplicate_ticks_cannot_improve_coverage(self):
        row = {"kind": "cycle", "payload": {"tick": 0, "markets": {}}}
        with self.assertRaisesRegex(ValueError, "duplicate"):
            summarize(plan(), [row, row], NOW + 20)

    def test_short_check_cannot_pass_full_day_gate(self):
        self.assertFalse(summarize(plan(seconds=120), [], NOW + 120)["data_gate_passed"])

    def test_display_or_heartbeat_never_replaces_the_venue_timestamp(self):
        with tempfile.TemporaryDirectory() as d:
            j = DurableJournal(Path(d) / "new")
            state = StreamState([SLUG], j); state.connected = True
            state.ingest(response()["body"], NOW)
            state.ingest({"heartbeat": {}}, NOW + 80)
            snap = state.snapshot(SLUG, NOW + 80)
            self.assertFalse(snap["usable"]); self.assertEqual(snap["book_at"], NOW - 1); j.close()

    def test_documented_wire_aliases_and_conflicts(self):
        md = response()["body"]["marketData"]
        snake = copy.deepcopy(md)
        snake["market_slug"] = snake.pop("marketSlug"); snake["transact_time"] = snake.pop("transactTime")
        self.assertEqual(normalize_market_message({"market_data": snake})["marketData"], md)
        with self.assertRaisesRegex(ValueError, "conflicting"):
            normalize_market_message({"market_data": snake, "marketData": md})

    def test_official_settlement_is_detected_before_requesting_a_stale_open_book(self):
        meta = target(); identity = market_identity(meta)
        meta.update(closed=True, status="MARKET_STATUS_RESOLVED")
        meta["marketSides"][0]["price"] = "1"
        client = FakeClient([response({"market": meta}), response({"slug": SLUG, "settlement": "1"})])
        with mock.patch("reliability_runner.time.time", return_value=NOW):
            value = observe(client, SLUG, identity, None, NOW)
        self.assertTrue(value["usable"]); self.assertEqual(value["kind"], "official_us_settlement")
        self.assertTrue(client.calls[-1].endswith("/settlement"))
        self.assertFalse(any(url.endswith("/book") for url in client.calls))

    def test_foreign_or_conflicting_payout_cannot_close_a_market(self):
        meta = target(); identity = market_identity(meta)
        meta.update(closed=True, status="MARKET_STATUS_RESOLVED"); meta["marketSides"][0]["price"] = "1"
        client = FakeClient([response({"market": meta}), response({"slug": SLUG, "settlement": "0"})])
        value = observe(client, SLUG, identity, None, NOW)
        self.assertFalse(value["usable"]); self.assertEqual(value["kind"], "unresolved_settlement")

    def test_changed_rules_reject_a_fresh_quote(self):
        meta = target(); identity = market_identity(meta); meta["description"] += " changed"
        book_response = response(); book_response["sent_at"] = NOW - .1
        client = FakeClient([response({"market": meta}), book_response])
        with mock.patch("reliability_runner.time.time", return_value=NOW):
            value = observe(client, SLUG, identity, None, NOW)
        self.assertFalse(value["usable"]); self.assertIn("market_identity_or_rules_changed", value["issues"])

    def test_retries_do_not_retry_auth_denial_or_stale_200(self):
        stop = mock.Mock()
        for status in (200, 401, 403, 429):
            client = mock.Mock(); client.get.return_value = {"status": status}
            RetryClient(client, stop).get("example")
            self.assertEqual(client.get.call_count, 1)
        client = mock.Mock(); client.get.side_effect = [{"status": 503}, {"status": 200}]
        self.assertEqual(RetryClient(client, stop).get("example")["status"], 200)
        self.assertEqual(client.get.call_count, 2)


class PublicationTests(unittest.TestCase):
    def test_save_path_check_fails_without_token_and_makes_no_network_request(self):
        from publication_smoke import main as smoke
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"PMUS_DATA_SECRET_KEY":"DO_NOT_ECHO"}, clear=True), mock.patch("publication.urllib.request.build_opener") as network, contextlib.redirect_stdout(io.StringIO()) as out:
            root=Path(d)/'new'
            self.assertEqual(smoke(['--output',str(root),'--run-id','123456789','--code-sha','a'*40]),1)
            network.assert_not_called()
            self.assertNotIn('DO_NOT_ECHO',out.getvalue())
            result=json.loads((root/'result.json').read_bytes())
            self.assertFalse(result['passed']);self.assertEqual(result['venue_or_account_requests'],0)
            self.assertEqual(result['market_cycles'],0)

    def test_save_path_check_cannot_replace_an_existing_result(self):
        from publication_smoke import main as smoke
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'existing';root.mkdir();result=root/'result.json';result.write_text('preserve')
            with self.assertRaises(FileExistsError):
                smoke(['--output',str(root),'--run-id','123456789','--code-sha','a'*40])
            self.assertEqual(result.read_text(),'preserve')

    def mirror(self, root):
        with mock.patch.dict(os.environ, {"GH_TOKEN": "synthetic-token"}):
            return GitMirror("123456789", "a" * 40, root)

    def test_publisher_is_confined_to_a_new_run_specific_research_branch(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.mirror(d)
            self.assertEqual(m.branch, "research/pmus-data-quality-state-123456789")
            with self.assertRaises(ValueError): m.request("/actions/runs")
            with self.assertRaises(ValueError): self.mirror(d).publish({"../../main": b"bad"}, {})

    def test_transient_github_500_retries_but_permission_denial_does_not(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.mirror(d)
            error = urllib.error.HTTPError("example", 500, "", {}, io.BytesIO())
            good = mock.MagicMock(); good.__enter__.return_value = io.StringIO('{"ok":true}')
            with mock.patch("publication.urllib.request.build_opener") as opener, mock.patch("publication.time.sleep"):
                opener.return_value.open.side_effect = [error, good]
                self.assertTrue(m.request("/git/refs")["ok"])
                self.assertEqual(opener.return_value.open.call_count, 2)
            error = urllib.error.HTTPError("example", 403, "", {}, io.BytesIO())
            with mock.patch("publication.urllib.request.build_opener") as opener:
                opener.return_value.open.side_effect = error
                with self.assertRaises(PublicationError): m.request("/git/refs")
                self.assertEqual(opener.return_value.open.call_count, 1)

    def test_upload_failure_keeps_sealed_bytes_and_open_journal(self):
        with tempfile.TemporaryDirectory() as d:
            j = DurableJournal(Path(d) / "new"); m = self.mirror(j.root)
            atomic_write(j.root / "plan.json", canonical(plan()))
            j.add("one", {}); j.seal({}); raw = j.path.read_bytes()
            with mock.patch.object(m, "publish", side_effect=PublicationError("offline")):
                with self.assertRaises(PublicationError): m.sync(j)
            self.assertIsNotNone(m.pending_files)
            self.assertEqual(j.path.read_bytes(), raw)
            j.add("still_collecting", {}); self.assertEqual(j.seq, 2)
            m.save(); restored = self.mirror(j.root)
            self.assertEqual(restored.pending_files, m.pending_files); j.close()

    def test_ambiguous_ref_update_reconciles_exact_saved_commit(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.mirror(d); m.head = "a" * 40
            m.pending_commit = {"sha": "b" * 40, "fingerprint": "f" * 64}
            with mock.patch.object(m, "request", side_effect=PublicationError("timeout")), mock.patch.object(m, "ref", return_value={"object": {"sha": "b" * 40}}):
                self.assertEqual(m._finish_pending(), "b" * 40)
            self.assertIsNone(m.pending_commit)
            saved = json.loads((Path(d) / "publication.json").read_bytes())
            self.assertEqual(saved["head"], "b" * 40)

    def test_pending_generation_cannot_be_changed_or_overwrite_a_concurrent_head(self):
        with tempfile.TemporaryDirectory() as d:
            m = self.mirror(d); m.head = "a" * 40
            m.pending_commit = {"sha": "b" * 40, "fingerprint": "f" * 64}
            with mock.patch.object(m, "ref", return_value={"object": {"sha": "c" * 40}}):
                with self.assertRaisesRegex(ValueError, "bytes changed"):
                    m.publish({"same": b"changed"}, {})

    def test_slow_publication_does_not_block_observations(self):
        with tempfile.TemporaryDirectory() as d:
            j = DurableJournal(Path(d) / "new")
            release, entered = threading.Event(), threading.Event()
            m = mock.Mock()
            def slow(*args):
                entered.set(); self.assertTrue(release.wait(3))
            m.sync.side_effect = slow
            background = BackgroundMirror(m, j); background.submit()
            self.assertTrue(entered.wait(1))
            j.add("observation_while_upload_waits", {})
            self.assertEqual(j.seq, 1)
            release.set(); background.close(); j.close()

    def test_remote_blob_identities_restore_the_exact_sealed_generation(self):
        with tempfile.TemporaryDirectory() as d:
            j = DurableJournal(Path(d) / "source")
            atomic_write(j.root / "plan.json", canonical(plan()))
            j.add("one", {}); j.seal({"run_id": "123456789"}); j.close()
            files = [j.root / "plan.json", j.root / "summary.json", *sorted((j.root / "checkpoints").glob("*/*"))]
            blobs, entries = {}, []
            for path in files:
                data = path.read_bytes(); blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                blobs[blob] = data
                entries.append({"type": "blob", "path": "data-results/123456789/" + str(path.relative_to(j.root)), "sha": blob, "size": len(data)})
            def request(path, *args, **kwargs):
                if path.startswith("/git/commits/"): return {"tree": {"sha": "c" * 40}}
                if path.startswith("/git/trees/"): return {"tree": entries, "truncated": False}
                return {"content": base64.b64encode(blobs[path.rsplit("/", 1)[-1]]).decode()}
            m = self.mirror(Path(d) / "restored")
            with mock.patch.object(m, "ref", return_value={"object": {"sha": "b" * 40}}), mock.patch.object(m, "request", side_effect=request):
                self.assertTrue(m.restore())
            restored = DurableJournal(m.root, resume=True)
            self.assertEqual(restored.rows, j.rows); self.assertEqual(restored.checkpoint, 1); restored.close()


if __name__ == "__main__":
    unittest.main()
