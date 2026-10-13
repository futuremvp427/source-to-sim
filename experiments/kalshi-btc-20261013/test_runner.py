import copy
import json
import tempfile
import unittest
from pathlib import Path

from runner import Client, Engine, UNIT, basis_for, coverage, epoch, fee_units, parse_book, quotes, strategy_signal, units, utc, walk_book

NOW = 1800000000
P = json.loads(Path(__file__).with_name("protocol.json").read_text())


def market(t=NOW,remaining=100):
    return {"ticker":"TEST-BTC-15","event_ticker":"TEST-BTC","floor_strike":100,
            "open_time":utc(t+remaining-900),"close_time":utc(t+remaining),
            "fee_type":"quadratic","fee_multiplier":1,"fee_checked_t":t,
            "basis_offset":None,"status":"active"}


def book(y="0.84",n="0.14",quantity="100"):
    return parse_book({"orderbook_fp":{"yes_dollars":[[y,quantity]],"no_dollars":[[n,quantity]]}})


class FinancialAndCausalityTests(unittest.TestCase):
    def test_complementary_asks_are_not_bids(self):
        q=quotes(book("0.60","0.35"))
        self.assertEqual(q["yes_ask"],6500)
        self.assertEqual(q["no_ask"],4000)
        self.assertGreater(q["yes_ask"]+q["no_ask"],UNIT)

    def test_no_liquidity_does_not_create_a_fill(self):
        f=walk_book({"yes":[],"no":[]},"yes","buy",50,1,0.5)
        self.assertEqual(f["qty"],0)

    def test_half_depth_and_partial_fill(self):
        f=walk_book(book(quantity="11.99"),"yes","buy",50,1,0.5,9000)
        self.assertEqual(f["qty"],5)
        self.assertEqual(f["gross_units"],5*8600)

    def test_walks_multiple_levels_and_respects_limit(self):
        b=parse_book({"orderbook_fp":{"yes_dollars":[["0.55","100"]],"no_dollars":[["0.40","8"],["0.38","8"],["0.30","100"]]}})
        f=walk_book(b,"yes","buy",50,1,0.5,6200)
        self.assertEqual(f["qty"],8)
        self.assertEqual(f["gross_units"],4*6000+4*6200)
        self.assertEqual(len(f["fills"]),2)

    def test_fees_use_quantity_and_multiplier_with_conservative_rounding(self):
        self.assertEqual(fee_units(8000,10),1200)
        self.assertEqual(fee_units(5000,50),8800)
        self.assertEqual(fee_units(5000,10,2),3500)

    def test_subcent_prices_are_kept_exact(self):
        self.assertEqual(units("0.9890"),9890)
        self.assertEqual(quotes(book("0.989","0.010"))["yes_ask"],9900)

    def test_crossed_and_duplicate_books_rejected(self):
        with self.assertRaises(ValueError):book("0.80","0.30")
        with self.assertRaises(ValueError):parse_book({"orderbook_fp":{"yes_dollars":[["0.1","5"],["0.1","5"]],"no_dollars":[]}})

    def test_signal_never_fills_on_the_signal_snapshot(self):
        e=Engine(P,now=NOW)
        e.observe(market(),book(),100,NOW)
        self.assertTrue(e.s["pending"])
        self.assertFalse(any(a["positions"] for a in e.s["accounts"].values()))
        e.observe(market(),book(),100,NOW+4)
        self.assertFalse(any(a["positions"] for a in e.s["accounts"].values()))

    def test_three_size_accounts_are_isolated_and_fill_on_next_book(self):
        e=Engine(P,now=NOW)
        e.observe(market(),book(),100,NOW)
        e.observe(market(),book("0.85","0.13"),100,NOW+5)
        for q in (10,25,50):
            a=e.s["accounts"]["late80_hold:"+str(q)]
            self.assertEqual(a["positions"]["TEST-BTC-15"]["initial_qty"],q)
            self.assertLess(a["cash_units"],1000*UNIT)
        self.assertEqual(e.s["accounts"]["panic_fade:50"]["cash_units"],1000*UNIT)

    def test_expired_order_has_no_fill_even_if_price_is_good(self):
        e=Engine(P,now=NOW)
        e.observe(market(),book(),100,NOW)
        e.observe(market(),book(),100,NOW+25)
        self.assertFalse(any(a["positions"] for a in e.s["accounts"].values()))

    def test_insufficient_cash_does_not_borrow(self):
        e=Engine(P,now=NOW)
        e.s["accounts"]["late80_hold:10"]["cash_units"]=100
        e.observe(market(),book(),100,NOW)
        e.observe(market(),book(),100,NOW+5)
        self.assertFalse(e.s["accounts"]["late80_hold:10"]["positions"])
        self.assertEqual(e.s["accounts"]["late80_hold:10"]["cash_units"],100)

    def test_official_settlement_is_exact_and_idempotent(self):
        e=Engine(P,now=NOW)
        e.observe(market(),book(),100,NOW)
        e.observe(market(),book(),100,NOW+5)
        a=e.s["accounts"]["late80_hold:10"]
        before=a["cash_units"]
        terminal={"ticker":"TEST-BTC-15","status":"finalized","result":"yes","settlement_value_dollars":"1.0000"}
        self.assertTrue(e.settle(terminal,NOW+400))
        self.assertEqual(a["cash_units"],before+10*UNIT)
        self.assertEqual(len(a["completed"]),1)
        self.assertEqual(a["completed"][0]["net_pnl_units"],100000-a["completed"][0]["entry_total_units"])
        again=a["cash_units"]
        e.settle(terminal,NOW+500)
        self.assertEqual(a["cash_units"],again)

    def test_provisional_and_nonbinary_settlements_are_not_finalized(self):
        e=Engine(P,now=NOW)
        self.assertFalse(e.settle({"ticker":"X","status":"determined","result":"yes"},NOW))
        self.assertFalse(e.settle({"ticker":"X","status":"finalized","result":"yes","settlement_value_dollars":"0.5"},NOW))

    def test_stop_exit_uses_next_bid_and_charges_second_fee(self):
        e=Engine(P,now=NOW)
        m=market(remaining=80)
        e.observe(m,book("0.91","0.07"),100,NOW)
        e.observe(m,book("0.92","0.06"),100,NOW+5)
        a=e.s["accounts"]["late90_exit:10"]
        self.assertTrue(a["positions"])
        e.observe(m,book("0.88","0.10"),100,NOW+10)
        self.assertTrue(a["positions"])
        self.assertTrue(a["positions"][m["ticker"]]["pending_exit"])
        e.observe(m,book("0.86","0.12"),100,NOW+15)
        self.assertFalse(a["positions"])
        row=a["completed"][0]
        self.assertEqual(row["exit_fills"][0]["gross_units"],10*8600)
        self.assertGreater(row["exit_fills"][0]["fee_units"],0)
        self.assertEqual(row["filled_legs_contracts"],20)

    def test_partial_exit_allocates_original_cost_once(self):
        e=Engine(P,now=NOW)
        e.observe(market(),book(),100,NOW)
        e.observe(market(),book(),100,NOW+5)
        a=e.s["accounts"]["late80_hold:10"]
        pos=a["positions"]["TEST-BTC-15"]
        original=pos["entry_total_units"]
        e.close_piece(a,pos,3,3*9000,100,NOW+10,"stop_loss",[])
        e.close_piece(a,pos,7,7*UNIT,0,NOW+400,"official_settlement",[])
        self.assertEqual(a["completed"][0]["net_pnl_units"],3*9000-100+7*UNIT-original)

    def test_stale_spot_disables_new_decisions(self):
        e=Engine(P,now=NOW)
        e.observe(market(),book(),None,NOW)
        self.assertFalse(e.s["pending"])

    def test_missing_history_does_not_invent_value_probability(self):
        cfg=next(x for x in P["strategies"] if x["id"]=="buffered_value")
        h=[{"t":NOW,"mid":0.5,"yes_ask":5100,"no_ask":5100}]
        self.assertIsNone(strategy_signal(cfg,h,[{"t":NOW,"spot":100}],market(remaining=300),NOW))

    def test_gap_in_history_fails_coverage(self):
        rows=[{"t":NOW-60},{"t":NOW-55},{"t":NOW}]
        self.assertFalse(coverage(rows,NOW-60,NOW))

    def test_allowlist_prevents_order_network_requests(self):
        with tempfile.TemporaryDirectory() as td:
            e=Engine(P,now=NOW);c=Client(Path(td)/"raw.gz",e)
            with self.assertRaises(ValueError):c.get("https://external-api.kalshi.com/trade-api/v2/portfolio/orders")
            with self.assertRaises(ValueError):c.get("https://example.com/")
            c.raw.close()


if __name__=="__main__":unittest.main()
