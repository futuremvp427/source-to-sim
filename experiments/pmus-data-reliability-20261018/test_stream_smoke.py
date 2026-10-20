import base64
import contextlib
import copy
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from probe import Journal, verify_journal
from test_quality import NOW, SLUG, response, target
from stream_smoke import (WS_PATH, WS_URL, StreamState, auth_headers, connect_market_stream,
                         inspect_stream, main, safe_error, safe_market_data,
                         select_markets, subscription)

SEED=bytes(range(32))
KEY=base64.b64encode(SEED).decode()


class StreamTests(unittest.TestCase):
    def test_signature_is_fixed_data_get_handshake(self):
        h=auth_headers("example-key",KEY,1792340000000)
        Ed25519PrivateKey.from_private_bytes(SEED).public_key().verify(
            base64.b64decode(h["X-PM-Signature"]),b"1792340000000GET/v1/ws/markets")
        self.assertEqual(set(h),{"X-PM-Access-Key","X-PM-Timestamp","X-PM-Signature"})

    def test_missing_and_invalid_keys_never_echo_inputs(self):
        for key,secret in [("",KEY),("example-key",""),("bad\r\nheader",KEY),
                           ("example-key","dont-print-this"),("example-key",base64.b64encode(b"a").decode())]:
            with self.assertRaises(ValueError) as err:
                auth_headers(key,secret)
            self.assertNotIn("dont-print-this",str(err.exception))
            self.assertNotIn("header",str(err.exception))

    def test_wrapped_base64_matches_official_sdk_format(self):
        wrapped=KEY[:22]+"\r\n  "+KEY[22:]
        h=auth_headers("example-key",wrapped,1792340000000)
        Ed25519PrivateKey.from_private_bytes(SEED).public_key().verify(
            base64.b64decode(h["X-PM-Signature"]),b"1792340000000GET/v1/ws/markets")
        from stream_smoke import credential_shape
        shape=credential_shape("example-key",wrapped)
        self.assertEqual(shape["secret_decoded_bytes"],32)
        self.assertNotIn(KEY,json.dumps(shape))

    def test_empty_keys_do_not_make_any_network_request(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ,{},clear=True), mock.patch("stream_smoke.PublicClient") as client, contextlib.redirect_stdout(io.StringIO()) as output:
            rc=main(["--output",str(Path(d)/"new"),"--approved-market-data-only"])
            result=json.loads(output.getvalue().split("=",1)[1])
            self.assertEqual(rc,1)
            self.assertEqual(result["failure"],"missing_key_id")
            client.assert_not_called()
            saved=json.loads((Path(d)/"new/summary.json").read_bytes())
            self.assertEqual(saved,result)

    def test_only_three_full_market_subscriptions(self):
        self.assertEqual(subscription([SLUG])["subscribe"]["subscriptionType"],"SUBSCRIPTION_TYPE_MARKET_DATA")
        for slugs in [[],[SLUG]*2,["/v1/ws/private"],["aec-a","aec-b","aec-c","aec-d"]]:
            with self.assertRaises(ValueError): subscription(slugs)

    def test_connector_has_no_redirect_and_fixed_destination(self):
        import websocket
        with mock.patch.object(websocket,"create_connection") as dial:
            conn=dial.return_value
            conn.getstatus.return_value=101
            connect_market_stream({"X-PM-Access-Key":"example"})
            self.assertEqual(dial.call_args.args[0],WS_URL)
            self.assertEqual(dial.call_args.kwargs["redirect_limit"],0)
            self.assertEqual(dial.call_args.kwargs["http_no_proxy"],["api.polymarket.us"])
            conn.getstatus.return_value=302
            with self.assertRaises(PermissionError):
                connect_market_stream({})
            conn.close.assert_called_once()

    def test_errors_never_include_exception_or_headers(self):
        error=RuntimeError("SECRET SECRET")
        self.assertNotIn("SECRET",safe_error(error))
        error.status_code=401
        self.assertEqual(safe_error(error),"authentication_denied_401")

    def test_safe_fields_drop_private_and_arbitrary_fields(self):
        md=response()["body"]["marketData"]
        md["private"]="secret"
        md["bids"][0]["account"]="private"
        cleaned=safe_market_data(md,[SLUG])
        self.assertNotIn("private",json.dumps(cleaned))
        self.assertNotIn("account",json.dumps(cleaned))
        md["bids"][0]["qty"]="secret"
        with self.assertRaises(ValueError): safe_market_data(md,[SLUG])

    def test_stream_uses_real_venue_time(self):
        md=response()["body"]["marketData"]
        self.assertTrue(inspect_stream(md,SLUG,NOW)["usable"])
        self.assertFalse(inspect_stream(md,SLUG,NOW+61)["usable"])
        self.assertFalse(inspect_stream(md,SLUG,NOW-8)["usable"])
        self.assertEqual(inspect_stream(md,SLUG,NOW+61)["book_at"],NOW-1)

    def test_heartbeat_does_not_refresh_book(self):
        with tempfile.TemporaryDirectory() as d:
            j=Journal(Path(d)/"new")
            s=StreamState([SLUG],j);s.connected=True
            s.ingest(response()["body"],NOW)
            s.ingest({"heartbeat":{}},NOW+70)
            x=s.snapshot(SLUG,NOW+70)
            self.assertFalse(x["usable"])
            self.assertEqual(x["book_at"],NOW-1)
            j.close();self.assertTrue(verify_journal(j.path)["verified"])

    def test_out_of_order_keeps_newer_book(self):
        with tempfile.TemporaryDirectory() as d:
            j=Journal(Path(d)/"new");s=StreamState([SLUG],j);s.connected=True
            s.ingest(response()["body"],NOW)
            s.ingest(response(at=NOW-1)["body"],NOW+1)
            self.assertEqual(s.snapshot(SLUG,NOW+1)["book_at"],NOW-1)
            self.assertEqual(s.counts["out_of_order_messages"],1)
            j.close()

    def test_conflicting_same_time_is_not_valid(self):
        with tempfile.TemporaryDirectory() as d:
            j=Journal(Path(d)/"new");s=StreamState([SLUG],j);s.connected=True
            msg=response()["body"];s.ingest(msg,NOW)
            changed=copy.deepcopy(msg);changed["marketData"]["bids"][0]["qty"]="21"
            s.ingest(changed,NOW+1)
            self.assertFalse(s.snapshot(SLUG,NOW+1)["usable"])
            s.ingest(changed,NOW+2)
            self.assertFalse(s.snapshot(SLUG,NOW+2)["usable"])
            s.ingest(response(at=NOW+3)["body"],NOW+3)
            self.assertTrue(s.snapshot(SLUG,NOW+3)["usable"])
            j.close()

    def test_transport_stale_or_closed_does_not_pass(self):
        with tempfile.TemporaryDirectory() as d:
            j=Journal(Path(d)/"new");s=StreamState([SLUG],j);s.connected=True
            s.ingest(response()["body"],NOW)
            self.assertFalse(s.snapshot(SLUG,NOW+31)["usable"])
            s.connected=False
            self.assertFalse(s.snapshot(SLUG,NOW+1)["usable"])
            j.close()

    def test_subscription_error_body_not_persisted(self):
        with tempfile.TemporaryDirectory() as d:
            j=Journal(Path(d)/"new");s=StreamState([SLUG],j)
            s.ingest({"error":"DO_NOT_PRINT"},NOW)
            self.assertEqual(s.failure,"subscription_error")
            self.assertEqual(j.seq,0)
            j.close()

    def test_wrong_market_rejected(self):
        with self.assertRaises(ValueError):
            safe_market_data(response()["body"]["marketData"],["aec-other"])

    def test_empty_suspended_or_one_sided_book_is_unusable(self):
        for key,value in [("bids",[]),("offers",[]),("state","MARKET_STATE_SUSPENDED")]:
            md=response()["body"]["marketData"];md[key]=value
            self.assertFalse(inspect_stream(md,SLUG,NOW)["usable"])

    def test_selection_uses_observed_catalog_only(self):
        self.assertEqual(select_markets({"complete":True,"markets":[target()]},NOW),[SLUG])
        for listing in [{"complete":False,"markets":[target()]},{"complete":True,"markets":[]}]:
            with self.assertRaises(ValueError): select_markets(listing,NOW)

    def test_nearer_unsupported_sport_does_not_replace_the_study_sports(self):
        tennis=target(slug="aec-itfwo-example-match-2026-10-20")
        tennis.update(sportsMarketType="tennis_match_winner",gameStartTime=__import__('datetime').datetime.fromtimestamp(NOW,__import__('datetime').timezone.utc).isoformat())
        self.assertEqual(select_markets({"complete":True,"markets":[tennis,target()]},NOW),[SLUG])
        with self.assertRaises(ValueError):
            select_markets({"complete":True,"markets":[tennis]},NOW)

    def test_partial_game_market_does_not_enter_the_diagnostic_plan(self):
        partial=target();partial['sportsMarketType']='nfl_first_half_winner'
        with self.assertRaises(ValueError):
            select_markets({"complete":True,"markets":[partial]},NOW)
        full=target();full['sportsMarketType']='moneyline'
        self.assertEqual(select_markets({"complete":True,"markets":[full]},NOW),[SLUG])

    def test_auth_denial_stops_without_public_fallback(self):
        fake_listing={"complete":True,"markets":[target()]}
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ,{"PMUS_DATA_KEY_ID":"example-key","PMUS_DATA_SECRET_KEY":KEY},clear=True), mock.patch("stream_smoke.catalog",return_value=fake_listing), mock.patch("stream_smoke.select_markets",return_value=[SLUG]), mock.patch("stream_smoke.connect_market_stream") as dial, mock.patch("stream_smoke.PublicClient") as client, contextlib.redirect_stdout(io.StringIO()) as output:
            exc=RuntimeError("DO_NOT_ECHO");exc.status_code=403;dial.side_effect=exc
            rc=main(["--output",str(Path(d)/"new"),"--approved-market-data-only"])
            self.assertEqual(rc,1)
            result=json.loads(output.getvalue().split("=",1)[1])
            self.assertEqual(result["failure"],"authentication_denied_403")
            self.assertNotIn("DO_NOT_ECHO",output.getvalue())
            self.assertNotIn(KEY,output.getvalue())
            client.return_value.get.assert_not_called()
            self.assertTrue(result["evidence"]["verified"])



    def test_complete_mock_run_and_public_evidence_export(self):
        class Clock:
            now=NOW
            def time(self): return self.now
            def wait(self,seconds): self.now+=max(0,seconds)
        clock=Clock()
        class Event:
            stopped=False
            def is_set(self): return self.stopped
            def set(self): self.stopped=True
            def wait(self,seconds): clock.wait(seconds)
        class Worker:
            def __init__(self,target,args,daemon):
                self.state=args[1]
            def start(self):
                self.state.ingest(response()["body"],clock.now)
            def join(self,timeout): pass
            def is_alive(self): return False
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ,{"PMUS_DATA_KEY_ID":"example-key","PMUS_DATA_SECRET_KEY":KEY},clear=True), mock.patch("stream_smoke.catalog",return_value={"complete":True,"markets":[target()]}), mock.patch("stream_smoke.select_markets",return_value=[SLUG]), mock.patch("stream_smoke.connect_market_stream") as dial, mock.patch("stream_smoke.PublicClient") as client, mock.patch("stream_smoke.time.time",side_effect=clock.time), mock.patch("stream_smoke.threading.Event",Event), mock.patch("stream_smoke.threading.Thread",Worker), contextlib.redirect_stdout(io.StringIO()) as output:
            client.return_value.get.return_value=response()
            rc=main(["--output",str(Path(d)/"new"),"--seconds","20","--approved-market-data-only","--export-public-evidence-in-log"])
            lines=output.getvalue().splitlines()
            result=json.loads(lines[0].split("=",1)[1])
            self.assertEqual(rc,0)
            self.assertTrue(result["passed"])
            self.assertTrue(result["authenticated_handshake"])
            self.assertFalse(result["ready_for_new_paper_study"])
            self.assertFalse(result["full_24_hour_test_started"])
            self.assertEqual(result["markets"][SLUG]["matched_fresh_pairs"],1)
            chunks=[x.split("=",1)[1] for x in lines[1:]]
            self.assertEqual(len(chunks),result["log_evidence"]["chunks"])
            import hashlib,zipfile
            raw=base64.b64decode("".join(chunks))
            self.assertEqual(hashlib.sha256(raw).hexdigest(),result["log_evidence"]["sha256"])
            self.assertEqual(len(raw),result["log_evidence"]["bytes"])
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                self.assertIn("raw.jsonl.xz",z.namelist())
            self.assertNotIn(KEY,output.getvalue())
            dial.return_value.send.assert_called_once()

if __name__=="__main__":
    unittest.main()
