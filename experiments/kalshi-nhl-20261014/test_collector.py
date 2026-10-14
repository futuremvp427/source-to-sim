import copy,json,tempfile,time,unittest
from pathlib import Path
from collector import *

class Tests(unittest.TestCase):
    def rawbook(self): return {"orderbook_fp":{"yes_dollars":[["0.80","20.00"]],"no_dollars":[["0.19","40.00"]]}}
    def test_book_complements(self): self.assertEqual(parse_book(self.rawbook())["yes_ask"],8100)
    def test_book_quantity_preserved(self): self.assertEqual(parse_book(self.rawbook())["yes"][0][1],"20.00")
    def test_crossed_rejected(self):
        b=self.rawbook();b["orderbook_fp"]["no_dollars"]=[["0.21","3"]]
        with self.assertRaises(ValueError): parse_book(b)
    def test_locked_rejected(self):
        b=self.rawbook();b["orderbook_fp"]["no_dollars"]=[["0.20","3"]]
        with self.assertRaises(ValueError): parse_book(b)
    def test_one_side_rejected(self):
        b=self.rawbook();b["orderbook_fp"]["no_dollars"]=[]
        with self.assertRaises(ValueError): parse_book(b)
    def test_duplicate_rejected(self):
        b=self.rawbook();b["orderbook_fp"]["yes_dollars"].append(["0.80","3"])
        with self.assertRaises(ValueError): parse_book(b)
    def test_negative_size_rejected(self):
        b=self.rawbook();b["orderbook_fp"]["yes_dollars"]=[["0.8","-1"]]
        with self.assertRaises(ValueError): parse_book(b)
    def test_precision_rejected(self):
        b=self.rawbook();b["orderbook_fp"]["yes_dollars"]=[["0.80001","1"]]
        with self.assertRaises(ValueError): parse_book(b)
    def test_clock_mmss(self): self.assertEqual(parse_clock({"clock":{"timeRemaining":"09:30"}})["seconds_remaining"],570)
    def test_bool_clock_rejected(self): self.assertIsNone(parse_clock({"clock":{"secondsRemaining":True}})["seconds_remaining"])
    def test_missing_clock(self): self.assertIsNone(parse_clock({})["seconds_remaining"])
    def test_no_receipt_as_source_time(self): self.assertIsNone(source_time({"received_at":100,"date":"2026-10-14"}))
    def test_explicit_iso_source(self): self.assertEqual(source_time({"lastUpdated":"1970-01-01T00:00:10Z"}),10)
    def test_game_mapping(self): self.assertEqual(game_key({"gameDate":"2026-10-14","awayTeam":{"abbrev":"MTL"},"homeTeam":{"abbrev":"WSH"}}),"KXNHLGAME-26OCT14MTLWSH")
    def test_public_allowlist(self): self.assertTrue(allowed(KALSHI+"/markets/trades?limit=1000"))
    def test_orders_forbidden(self): self.assertFalse(allowed(KALSHI+"/portfolio/orders"))
    def test_auth_host_forbidden(self): self.assertFalse(allowed("https://example.com/trade-api/v2/markets"))
    def test_http_forbidden(self): self.assertFalse(allowed(KALSHI.replace("https:","http:")+"/markets"))
    def test_userinfo_forbidden(self): self.assertFalse(allowed("https://secret@external-api.kalshi.com/trade-api/v2/markets"))
    def test_blocked_pbp_not_allowlisted(self): self.assertFalse(allowed(NHL+"/gamecenter/2026020106/play-by-play"))
    def test_nhl_landing_allowed(self): self.assertTrue(allowed(NHL+"/gamecenter/2026020106/landing"))
    def test_cached_response_stale(self): self.assertFalse(fresh_response({"http_status":200,"body":{},"received_at":100,"headers":{"age":"11"}},100,10))
    def test_future_receipt_rejected(self): self.assertFalse(fresh_response({"http_status":200,"body":{},"received_at":101},100,10))
    def state(self):
        return {"study_id":"test","raw_seq":0,"raw_hash":"0"*64,"raw_bytes":0,"health":{"http_calls":0,"http_errors":0},"protocol_hash":"p","code_hash":"c","last_cycle_at":time.time(),"games":{},"started_at":time.time(),"entry_end_at":time.time()+172800,"finished":False,"halt_reason":None}
    def test_hash_chain(self):
        s=self.state();j=Journal(s);j.add("event",{"x":1});j.add("event",{"x":2})
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"raw.gz"
            with gzip.open(p,"wb") as f: f.writelines(j.rows)
            n,head=verify_raw(p,"0"*64);self.assertEqual(n,2);self.assertEqual(head,s["raw_hash"])
    def test_chain_tamper_detected(self):
        s=self.state();j=Journal(s);j.add("event",{"x":1});row=json.loads(j.rows[0]);row["payload"]["x"]=2
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"raw.gz"
            with gzip.open(p,"wb") as f:f.write(canonical(row)+b"\n")
            with self.assertRaises(ValueError):verify_raw(p,"0"*64)
    def test_empty_results_not_profit(self):
        x=summarize(self.state());self.assertIsNone(x["paper_pnl"]);self.assertIsNone(x["paper_fills"]);self.assertEqual(x["venue_orders"],0)
    def test_no_games_not_ready(self):
        s=self.state();s["finished"]=True;self.assertEqual(summarize(s)["rehearsal_status"],"INSUFFICIENT_COVERAGE")
    def test_unverified_clock_semantics_cannot_decide(self):
        p=json.loads((ROOT/"protocol.json").read_text());s=self.state();s["series_fee"]={"fee_type":"quadratic_with_maker_fees","fee_multiplier":1}
        g={"id":1,"counters":{},"last_poll":0,"first_seen_at":time.time(),"market":{"ticker":"TEST"},"mapping_verified":True,"recent_trade_ids":{},"tape_watermark":None,"started_candidate_at":None,"last_candidate_at":None,"max_candidate_gap":0,"candidate_entry_boundary_observed":False}
        raw=self.rawbook()
        class Fake:
            def get(self,url):
                now=time.time();body=raw if url.endswith("/orderbook") else {"trades":[],"cursor":""}
                return {"url":url,"sent_at":now,"received_at":now,"request_seconds":0.01,"http_status":200,"headers":{},"body":body,"error":None}
        now=time.time();landing={"received_at":now,"http_status":200,"headers":{},"body":{"gameState":"LIVE","periodDescriptor":{"number":3},"clock":{"secondsRemaining":600},"lastUpdated":utc(now)},"error":None}
        c=Collector(p,s,Fake());c.observe(g,landing)
        self.assertEqual(g["counters"]["valid_decision_cycles"],0)
        self.assertEqual(g["counters"]["clock_source_semantics_unverified"],1)
    def test_permission_denial_stops_no_retry(self):
        p=json.loads((ROOT/"protocol.json").read_text());s=self.state()
        class Fake:
            def get(self,url):return {"http_status":403,"error":"Forbidden","received_at":time.time()}
        c=Collector(p,s,Fake())
        with self.assertRaises(PermissionError):c.request(NHL+"/score/2026-10-14")
        self.assertTrue(s["finished"]);self.assertEqual(s["halt_reason"],"PUBLIC_SOURCE_PERMISSION_DENIED")
    def test_manifest_resume(self):
        p=json.loads((ROOT/"protocol.json").read_text());s=self.state();c=Collector(p,s,None);c.j.add("event",{"hello":"world"})
        with tempfile.TemporaryDirectory() as d:
            export(c,Path(d)/"work",Path(d)/"out","00","00")
            self.assertEqual(verify_checkpoint(Path(d)/"work")["raw_hash"],s["raw_hash"])
            (Path(d)/"work"/"state.json").write_text("{}")
            with self.assertRaises(ValueError):verify_checkpoint(Path(d)/"work")

if __name__=="__main__":unittest.main()
