"""Regression checks for the observed 1 GiB WAL and artifact recovery failure."""
import collections
import contextlib
import copy
import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from durable import DurableJournal, atomic_write, decode_rows
from publication import GitMirror, PublicationError
from quality import canonical, digest
from recover_backup import recover
from reliability_runner import main
from stream_smoke import StreamState
from test_quality import NOW, SLUG, response


class CompactEvidenceTests(unittest.TestCase):
    def test_every_receipt_is_bound_to_full_selected_book_and_survives_resume(self):
        md=response()["body"]["marketData"]
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/"new";j=DurableJournal(root)
            receipt=j.stream_receipt(md,NOW)
            captured=j.capture_stream_book(md,NOW,receipt)
            self.assertEqual(j.capture_stream_book(md,NOW,receipt),captured)
            self.assertEqual(j.seq,2)
            selected=j.rows[captured["seq"]-1]
            self.assertEqual(selected["payload"]["market_data"],md)
            self.assertEqual(selected["payload"]["receipt_evidence"],receipt)
            self.assertLess(receipt["seq"],captured["seq"])
            j.seal({});j.close()
            recovered=DurableJournal(root,resume=True)
            self.assertEqual(recovered.capture_stream_book(md,NOW,receipt),captured)
            self.assertEqual(recovered.seq,2);recovered.close()

    def test_changed_book_time_or_receipt_cannot_be_substituted(self):
        md=response()["body"]["marketData"]
        with tempfile.TemporaryDirectory() as d:
            j=DurableJournal(Path(d)/"new");r=j.stream_receipt(md,NOW)
            changed=copy.deepcopy(md);changed["bids"][0]["px"]="0.01"
            for book,at,ref in [(changed,NOW,r),(md,NOW+1,r),(md,NOW,{**r,"hash":"0"*64})]:
                with self.assertRaisesRegex(ValueError,"receipt_mismatch"):
                    j.capture_stream_book(book,at,ref)
            self.assertEqual(j.seq,1);j.close()

    def test_stream_snapshots_persist_complete_books_before_returning_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            j=DurableJournal(Path(d)/"new");s=StreamState([SLUG],j);s.connected=True
            s.ingest(response()["body"],NOW)
            self.assertEqual(j.rows[0]["kind"],"stream_book_receipt")
            value=s.snapshot(SLUG,NOW)
            self.assertTrue(value["usable"])
            full=j.rows[value["evidence"]["seq"]-1]
            self.assertEqual(full["kind"],"stream_book")
            self.assertEqual(full["payload"]["market_data"],s.latest[SLUG]["body"])
            self.assertEqual(s.snapshot(SLUG,NOW)["evidence"],value["evidence"])
            self.assertEqual(j.seq,2);j.close()

    def test_burst_does_not_store_full_depth_for_unused_receipts(self):
        md=copy.deepcopy(response()["body"]["marketData"])
        md["bids"]*=100;md["offers"]*=100
        old_bytes=0
        with tempfile.TemporaryDirectory() as d:
            j=DurableJournal(Path(d)/"new")
            for i in range(100):
                r=j.stream_receipt(md,NOW+i)
                old_bytes+=len(canonical({"market_data":md,"received_at":NOW+i}))
                if i%20==0:j.capture_stream_book(md,NOW+i,r)
            self.assertEqual(sum(row["kind"]=="stream_book_receipt" for row in j.rows),100)
            self.assertEqual(sum(row["kind"]=="stream_book" for row in j.rows),5)
            self.assertLess(j.total,old_bytes*.15);j.close()

    def test_historical_alignment_captures_exact_previously_received_full_book(self):
        from quality import inspect_book
        with tempfile.TemporaryDirectory() as d:
            j=DurableJournal(Path(d)/"new");s=StreamState([SLUG],j);s.connected=True
            old=response();s.ingest(old["body"],NOW)
            new=response(at=NOW+10);new["body"]["marketData"]["bids"][0]["qty"]="25"
            s.ingest(new["body"],NOW+10)
            match=s.compare_rest(inspect_book(old,SLUG,now=NOW+11),NOW+11)
            self.assertTrue(match["matched"])
            selected=j.rows[match["stream_evidence"]["seq"]-1]
            self.assertEqual(selected["kind"],"stream_book")
            self.assertEqual(selected["payload"]["market_data"],old["body"]["marketData"])
            self.assertEqual(selected["payload"]["received_at"],NOW)
            self.assertLessEqual(selected["payload"]["received_at"],match["compared_at"])
            self.assertEqual(s.snapshot(SLUG,NOW+11)["book_at"],NOW+9);j.close()


class BackupRecoveryTests(unittest.TestCase):
    def backup(self,root,index):
        p=root/f"pmus-data-soak-123456789-1-soak_{index:02d}";p.mkdir()
        (p/"events.jsonl").write_bytes(b"preserved-wal")
        for name in ("plan.json","publication.json"):
            (p/name).write_bytes(canonical({"run_id":"123456789","code_sha":"a"*40}))
        return p

    def test_latest_available_backup_is_used_after_intermediate_job_has_no_artifact(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/"backups";root.mkdir();self.backup(root,0);self.backup(root,2)
            output=Path(d)/"data"
            name=recover(root,output,"123456789",1,"a"*40)
            self.assertTrue(name.endswith("soak_02"))
            self.assertEqual((output/"events.jsonl").read_bytes(),b"preserved-wal")

    def test_incomplete_newest_backup_is_not_silently_replaced_by_older_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/"backups";root.mkdir();self.backup(root,0)
            latest=self.backup(root,2);(latest/"events.jsonl").unlink()
            with self.assertRaisesRegex(ValueError,"incomplete_latest"):
                recover(root,Path(d)/"data","123456789",1,"a"*40)
            self.assertFalse((Path(d)/"data").exists())

    def test_existing_local_backup_avoids_re_downloading_remote_git_blobs(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/"data";j=DurableJournal(root)
            atomic_write(root/"plan.json",canonical({"run_id":"123456789","code_sha":"a"*40,
                "duration_seconds":20,"stream_enabled":False,"started_at":NOW-100,"markets":{SLUG:{"identity":"b"*64}}}))
            atomic_write(root/"publication.json",b"{}");j.add("one",{});j.close()
            with mock.patch("reliability_runner.GitMirror") as mirror, mock.patch("reliability_runner.BackgroundMirror") as background,contextlib.redirect_stdout(io.StringIO()):
                background.return_value.errors=0
                code=main(["--output",str(root),"--run-id","123456789","--code-sha","a"*40,
                           "--duration-seconds","20","--segment-seconds","20","--resume","--mirror","--approved-data-only"])
            self.assertEqual(code,0);mirror.return_value.restore.assert_not_called()


class RateLimitRecoveryTests(unittest.TestCase):
    def test_long_retry_after_is_deferred_without_blocking_collection_or_exposing_body(self):
        with tempfile.TemporaryDirectory() as d,mock.patch.dict(os.environ,{"GH_TOKEN":"NEVER_PRINT_TOKEN"}):
            mirror=GitMirror("123456789","a"*40,d)
            error=urllib.error.HTTPError("example",403,"",{"Retry-After":"120","X-GitHub-Request-Id":"SAFE:ID"},
                io.BytesIO(b'{"message":"secondary rate limit NEVER_PRINT_BODY"}'))
            with mock.patch("publication.urllib.request.build_opener") as opener,mock.patch("publication.time.sleep") as sleep:
                opener.return_value.open.side_effect=error
                with self.assertRaises(PublicationError) as failure:mirror.request("/git/ref/heads/example")
                self.assertEqual(opener.return_value.open.call_count,1);sleep.assert_not_called()
                with self.assertRaises(PublicationError):mirror.request("/git/ref/heads/example")
                self.assertEqual(opener.return_value.open.call_count,1)
            self.assertEqual(failure.exception.details["classification"],"rate_limit")
            diagnostic=(Path(d)/"publication-diagnostic.json").read_text()
            self.assertNotIn("NEVER_PRINT",diagnostic)
            mirror.save();reloaded=GitMirror("123456789","a"*40,d)
            self.assertEqual(reloaded.retry_not_before,mirror.retry_not_before)

    def test_primary_limit_uses_reset_and_keeps_permission_errors_distinct(self):
        with tempfile.TemporaryDirectory() as d,mock.patch.dict(os.environ,{"GH_TOKEN":"synthetic"}):
            mirror=GitMirror("123456789","a"*40,d)
            error=urllib.error.HTTPError("example",403,"",{"X-RateLimit-Remaining":"0","X-RateLimit-Reset":str(NOW+3600)},io.BytesIO())
            with mock.patch("publication.time.time",return_value=NOW),mock.patch("publication.urllib.request.build_opener") as opener:
                opener.return_value.open.side_effect=error
                with self.assertRaises(PublicationError):mirror.request("/git/ref/heads/example")
            self.assertEqual(mirror.retry_not_before,NOW+3600)


if __name__=="__main__":unittest.main()
