import copy
import base64
import hashlib
import json
import tempfile
import unittest
from email.utils import formatdate
from pathlib import Path
from unittest.mock import patch

import live_gate as g


def fixture(mode='live'):
    watch = {'markets': [{'market_slug': 'aec-nhl-ana-nj-2026-10-22'},
                         {'market_slug': 'aec-nhl-fla-pit-2026-10-22'}]}
    plan = {'run_id': '39599999999', 'code_sha': 'a' * 40, 'mode': mode,
        'watch': watch, 'duration_seconds': 1800 if mode == 'live' else 120, 'started_at': 1000}
    rows = []
    for tick in range(plan['duration_seconds'] // 20):
        rows.append({'kind': 'live_gate_cycle', 'payload': {'tick': tick,
            'markets': {m['market_slug']: {'phase': {'usable': True},
                'book': {'kind': 'book', 'usable': True, 'stream': {'usable': True},
                         'comparison': {'matched': True, 'book_at': 1000 + tick * 20}}} for m in watch['markets']},
            'sources': {w['address']: {'usable': True} for w in g.PROTOCOL['wallets']}}})
    return plan, rows


class LiveGateTests(unittest.TestCase):
    def test_extra_http_digest_is_replayed_and_corruption_rejected(self):
        data = b'{"event":{}}'
        row = {'kind': 'event_http', 'payload': {'method': 'GET', 'authenticated': False,
            'url': 'https://gateway.polymarket.us/v1/events/slug/nhl-ana-nj-2026-10-22',
            'raw_base64': base64.b64encode(data).decode(), 'body_bytes': len(data),
            'body_sha256': hashlib.sha256(data).hexdigest()}}
        g.verify_extra_http([row])
        row['payload']['raw_base64'] = base64.b64encode(data + b' ').decode()
        with self.assertRaisesRegex(ValueError, 'supplemental_http_body_digest_mismatch'):
            g.verify_extra_http([row])

    def test_event_response_does_not_mutate_already_fsynced_payload(self):
        class Response:
            status = 200
            headers = {'Date': 'Thu, 22 Oct 2026 23:00:00 GMT'}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return b'{"event":{}}'
        with tempfile.TemporaryDirectory() as directory:
            j = g.DurableJournal(Path(directory) / 'journal')
            try:
                with patch.object(g.urllib.request, 'build_opener') as opener:
                    opener.return_value.open.return_value = Response()
                    response = g.EventClient(j).get('nhl-ana-nj-2026-10-22')
                self.assertIn('evidence', response)
                j.seal({'test': True})
                checked = g.verify_checkpoints(j.root)
                self.assertEqual(checked['rows'], j.rows)
            finally:
                j.close()

    def test_full_valid_live_window_passes(self):
        p, rows = fixture()
        self.assertTrue(g.summarize(p, rows, 2800)['live_gate_passed'])

    def test_waiting_before_end_cannot_pass(self):
        p, rows = fixture()
        self.assertFalse(g.summarize(p, rows[:-1], 2780)['live_gate_passed'])

    def test_settlements_never_count_as_live_quotes(self):
        p, rows = fixture()
        for row in rows:
            for market in row['payload']['markets'].values():
                market['book']['kind'] = 'official_us_settlement'
        value = g.summarize(p, rows, 2800)
        self.assertFalse(value['live_gate_passed'])
        self.assertTrue(all(x['valid_live_quote_ticks'] == 0 for x in value['markets'].values()))

    def test_stream_heartbeat_or_receipt_without_usable_book_fails(self):
        p, rows = fixture()
        for row in rows:
            for market in row['payload']['markets'].values():
                market['book']['stream']['usable'] = False
        self.assertFalse(g.summarize(p, rows, 2800)['live_gate_passed'])

    def test_source_failures_stay_in_full_planned_denominator(self):
        p, rows = fixture()
        address = g.PROTOCOL['wallets'][0]['address']
        for row in rows[:5]:
            row['payload']['sources'][address]['usable'] = False
        self.assertFalse(g.summarize(p, rows, 2800)['live_gate_passed'])

    def test_four_missing_ticks_still_meet_95_percent(self):
        p, rows = fixture()
        self.assertTrue(g.summarize(p, rows[4:], 2800)['live_gate_passed'])

    def test_five_missing_ticks_cannot_meet_95_percent(self):
        p, rows = fixture()
        value = g.summarize(p, rows[5:], 2800)
        self.assertFalse(value['live_gate_passed'])
        self.assertTrue(value['cannot_reach_95_percent'])

    def test_repeating_one_matching_snapshot_does_not_supply_three_pairs(self):
        p, rows = fixture()
        for row in rows:
            for market in row['payload']['markets'].values():
                market['book']['comparison']['book_at'] = 1000
        self.assertFalse(g.summarize(p, rows, 2800)['live_gate_passed'])

    def test_preflight_never_certifies_in_play(self):
        p, rows = fixture('preflight')
        value = g.summarize(p, rows, 1120)
        self.assertTrue(value['preflight_passed'])
        self.assertFalse(value['live_gate_passed'])
        self.assertFalse(value['actual_in_play_phase_certified'])

    def test_duplicate_tick_is_invalid(self):
        p, rows = fixture()
        with self.assertRaisesRegex(ValueError, 'duplicate_or_invalid_gate_tick'):
            g.summarize(p, rows + [rows[0]], 2800)

    def test_phase_requires_explicit_live_not_just_scheduled_start(self):
        meta = {'slug': 'aec-nhl-ana-nj-2026-10-22', 'gameStartTime': '2026-10-22T23:00:00Z',
            'description': 'rules', 'category': 'sports', 'marketType': 'moneyline',
            'marketSides': [{'id': '1', 'long': True, 'description': 'Ducks'},
                            {'id': '2', 'long': False, 'description': 'Devils'}]}
        item = {'event_slug': 'nhl-ana-nj-2026-10-22', 'event_id': '168916',
            'start_at': g.MODEL.stamp(meta['gameStartTime']), 'market_slug': meta['slug'],
            'market_identity': g.market_identity(meta)}
        at = item['start_at'] + 3600
        event = {'id': '168916', 'slug': item['event_slug'], 'startTime': meta['gameStartTime'],
            'markets': [meta], 'active': True, 'closed': False, 'period': 'NS'}
        response = {'status': 200, 'error': None, 'headers': {'date': formatdate(at, usegmt=True)},
            'received_at': at, 'body': {'event': event}, 'evidence': {'seq': 1, 'hash': 'a' * 64}}
        self.assertFalse(g.phase(response, item)['usable'])
        event['live'] = True
        self.assertTrue(g.phase(response, item)['usable'])
        event['ended'] = True
        self.assertFalse(g.phase(response, item)['usable'])

    def test_allowlist_rejects_orders_and_redirect_authority(self):
        self.assertFalse(g.event_url_allowed('https://api.polymarket.us/v1/orders'))
        self.assertFalse(g.event_url_allowed('https://gateway.polymarket.us@evil.example/v1/events/slug/nhl-ana-nj-2026-10-22'))
        self.assertFalse(g.event_url_allowed('https://gateway.polymarket.us/v1/events/slug/nhl-ana-nj-2026-10-22?next=evil'))
        self.assertTrue(g.event_url_allowed('https://gateway.polymarket.us/v1/events/slug/nhl-ana-nj-2026-10-22'))


if __name__ == '__main__':
    unittest.main()
