"""Regressions for bounded cache recovery without changing qualification gates."""
import copy
import json
import unittest
from email.utils import formatdate
from unittest.mock import patch

import live_gate as g


class Clock:
    def __init__(self): self.now = 1792711000.0
    def time(self): return self.now
    def sleep(self, seconds): self.now += seconds


class PhaseCacheTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        meta = {'slug': 'aec-nhl-ana-nj-2026-10-22', 'gameStartTime': '2026-10-22T23:00:00Z',
                'description': 'rules', 'category': 'sports', 'marketType': 'moneyline',
                'marketSides': [{'id': '1', 'long': True, 'description': 'Ducks'},
                                {'id': '2', 'long': False, 'description': 'Devils'}]}
        self.item = {'event_slug': 'nhl-ana-nj-2026-10-22', 'event_id': '168916',
                     'market_slug': meta['slug'], 'start_at': g.MODEL.stamp(meta['gameStartTime']),
                     'market_identity': g.market_identity(meta)}
        self.event = {'slug': self.item['event_slug'], 'id': '168916', 'markets': [meta],
                      'startTime': meta['gameStartTime'], 'active': True, 'closed': False,
                      'live': True, 'ended': False}
        self.calls = []

    def response(self, age=None, **extra):
        value = {'body': {'event': copy.deepcopy(self.event)}, 'status': 200, 'error': None,
                 'received_at': self.clock.now, 'headers': {'date': formatdate(self.clock.now, usegmt=True),
                 'cache-control': 'public, max-age=30'},
                 'evidence': {'seq': len(self.calls), 'hash': str(len(self.calls)) * 64}}
        if age is not None: value['headers']['age'] = str(age)
        return value | extra

    def exercise(self, ages, mutate=None, scheduled=None):
        client = g.EventClient(None)
        def get(slug, event_id=None, deadline=None):
            self.calls.append((slug, event_id, deadline))
            value = self.response(ages[min(len(self.calls)-1, len(ages)-1)])
            if mutate: mutate(value)
            return value
        with patch.object(client, 'get', side_effect=get), patch.object(g.time, 'time', self.clock.time), patch.object(g.time, 'sleep', self.clock.sleep):
            value = client.fresh(self.item, self.clock.now if scheduled is None else scheduled)
        return value

    def test_fresh_primary_uses_one_read(self):
        value = self.exercise([None])
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(g.phase(value, self.item)['usable'])

    def test_stale_primary_uses_only_exact_documented_id(self):
        value = self.exercise([25, None])
        self.assertEqual([c[1] for c in self.calls], [None, '168916'])
        self.assertEqual([x['seq'] for x in value['attempt_evidence']], [1, 2])
        self.assertTrue(g.phase(value, self.item)['usable'])

    def test_two_cached_routes_wait_for_ttl_within_original_tick(self):
        initial = self.clock.now
        value = self.exercise([25, 24, None])
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(self.clock.now-initial, 6.25)
        self.assertEqual(value['scheduled_at'], initial)
        self.assertEqual(value['phase_read_deadline'], initial+16)
        self.assertTrue(g.phase(value, self.item)['usable'])

    def test_no_wait_or_retry_beyond_tick_budget(self):
        scheduled = self.clock.now - 10
        value = self.exercise([25, 21, None], scheduled=scheduled)
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(g.phase(value, self.item)['usable'])

    def test_stale_retry_stays_stale_and_does_not_loop(self):
        value = self.exercise([25, 25, 25])
        self.assertEqual(len(self.calls), 3)
        self.assertIn('stale_http_cache', g.phase(value, self.item)['issues'])

    def test_foreign_identity_cannot_trigger_fallback(self):
        value = self.exercise([25], lambda x: x['body']['event'].update(id='999'))
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(g.phase(value, self.item)['usable'])

    def test_fresh_ended_response_can_never_certify_live(self):
        self.event.update(live=False, ended=True, closed=True)
        value = self.exercise([25, None])
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(g.phase(value, self.item)['usable'])

    def test_future_date_cannot_be_cured_by_fresh_age(self):
        value = self.exercise([0], lambda x: x['headers'].update(date=formatdate(self.clock.now+30, usegmt=True)))
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(g.phase(value, self.item)['usable'])

    def test_missing_date_and_malformed_body_fail_without_retry(self):
        value = self.exercise([25], lambda x: (x.update(body=[]), x['headers'].pop('date')))
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(g.phase(value, self.item)['usable'])

    def test_rate_limit_does_not_switch_routes(self):
        value = self.exercise([25], lambda x: x.update(status=429, error='HTTP_429'))
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(g.phase(value, self.item)['usable'])

    def test_permission_failure_is_not_retried(self):
        client = g.EventClient(None)
        with patch.object(client, 'get', side_effect=PermissionError('event_access_denied_403')) as get:
            with self.assertRaises(PermissionError): client.fresh(self.item, self.clock.now)
        self.assertEqual(get.call_count, 1)

    def test_after_deadline_receipt_is_rejected(self):
        value = self.exercise([None])
        value['received_at'] = value['phase_read_deadline'] + .01
        value['headers']['date'] = formatdate(value['received_at'], usegmt=True)
        self.assertIn('phase_read_deadline_elapsed', g.phase(value, self.item)['issues'])

    def test_id_allowlist_rejects_unwatched_private_and_query_urls(self):
        self.assertTrue(g.event_url_allowed('https://gateway.polymarket.us/v1/events/168916'))
        for url in ('https://gateway.polymarket.us/v1/events/999',
                    'https://gateway.polymarket.us/v1/events/168916?nonce=1',
                    'https://gateway.polymarket.us/v1/orders',
                    'https://gateway.polymarket.us/v1/events/168916/settlement'):
            self.assertFalse(g.event_url_allowed(url))


if __name__ == '__main__': unittest.main()
