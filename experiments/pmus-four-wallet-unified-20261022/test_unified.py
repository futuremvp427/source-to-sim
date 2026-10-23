"""Offline end-to-end and injected failure tests; no real source-return claims."""
import base64
import copy
import hashlib
import json
import tempfile
import time
import unittest
from email.utils import formatdate
from pathlib import Path
from unittest.mock import patch

import core
import run
from verify import verify

P = core.protocol()
FIXTURE = json.loads((core.REFERENCE / 'mapping_fixtures.json').read_bytes())[0]


class FakeStream:
    def __init__(self, journal):
        self.state = core.StreamState([FIXTURE['us']['slug']], core.StreamReceiptBuffer(journal))
        self.state.connected = True

    def ensure(self, slug):
        pass

    def retain(self, slugs):
        pass

    def update(self, now, bid='.59', ask='.61', qty='100'):
        self.state.ingest({'marketData': {'marketSlug': FIXTURE['us']['slug'], 'state': 'MARKET_STATE_OPEN',
            'transactTime': core.MODEL.iso(now),
            'bids': [{'px': {'value': bid, 'currency': 'USD'}, 'qty': qty}],
            'offers': [{'px': {'value': ask, 'currency': 'USD'}, 'qty': qty}]}}, now)


class FakeNetwork:
    def __init__(self, log, buy_at):
        self.journal, self.p = log, P
        self.buy_at, self.resolved, self.positions_fail = buy_at, False, False
        self.foreign_closed, self.stale_http = False, False
        self.extra_buys = []
        self.buy = {'proxy_wallet': P['wallets'][0]['address'], 'timestamp': buy_at,
            'side': 'BUY', 'condition_id': FIXTURE['source']['conditionId'],
            'token_id': json.loads(FIXTURE['source']['clobTokenIds'])[0],
            'slug': FIXTURE['source']['slug'], 'event_slug': FIXTURE['source']['slug'],
            'transaction_hash': 'fixture-transaction', 'size': '100', 'price': '.60'}

    def get(self, url):
        import urllib.parse
        u = urllib.parse.urlsplit(url)
        q = urllib.parse.parse_qs(u.query)
        now = time.time()
        if u.path == '/v2/trades':
            data = [self.buy, *self.extra_buys] if q['user'] == [P['wallets'][0]['address']] else []
            body = {'data': copy.deepcopy(data), 'pagination': {'has_more': False}}
        elif u.path == '/v2/positions':
            if self.positions_fail:
                raise ValueError('fixture_foreign_source_unavailable')
            body = {'data': [{'proxy_wallet': q['user'][0], 'condition_id': self.buy['condition_id'],
                'token_id': self.buy['token_id'], 'outcome': json.loads(FIXTURE['source']['outcomes'])[0],
                'current_size': '100', 'last_event_at': self.buy_at}], 'pagination': {'has_more': False}}
        elif u.netloc == 'gamma-api.polymarket.com':
            body = [copy.deepcopy(FIXTURE['source'])]
            if self.foreign_closed:
                body = body if q.get('closed') == ['any'] else []
                if body:
                    body[0].update(closed=True, active=False)
        elif '/market/slug/' in u.path:
            market = copy.deepcopy(FIXTURE['us'])
            if self.resolved:
                market.update(status='MARKET_STATUS_RESOLVED', closed=True)
                for side in market['marketSides']:
                    side['price'] = '1' if side['long'] else '0'
            body = {'market': market}
        elif u.path.endswith('/settlement'):
            body = {'slug': FIXTURE['us']['slug'], 'settlement': '1'}
        else:
            raise AssertionError(url)
        raw = core.canonical(body)
        self.journal.add('http', {'url': url, 'method': 'GET', 'authenticated': False,
            'sent_at': now, 'received_at': now, 'http_status': 200,
            'headers': {'date': formatdate(now - (400 if self.stale_http else 0), usegmt=True), 'age': '0'},
            'body_bytes': len(raw), 'body_sha256': hashlib.sha256(raw).hexdigest(),
            'raw_base64': base64.b64encode(raw).decode(), 'error': None})
        self.journal.state['http_calls'] += 1
        return body, now


class IntegratedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'paper'
        self.journal = core.PaperJournal(self.root)
        self.now = core.MODEL.stamp(FIXTURE['us']['gameStartTime']) - 3600
        self.state = core.initial_state(P, 'a' * 40, self.now - 60)
        self.plan = {'run_id': '12345678901', 'code_sha': 'a' * 40,
                     'protocol_sha256': self.state['protocol_sha256']}
        core.atomic_write(self.root / 'plan.json', core.canonical(self.plan), immutable=True)
        self.journal.add('paper_initial_state', self.state)
        self.stream = FakeStream(self.journal)
        self.collector = core.IntegratedCollector(self.state, P, self.journal, self.stream)
        self.collector.net = FakeNetwork(self.collector.journal, self.now - 10)

    def tearDown(self):
        self.journal.close()
        self.temp.cleanup()

    def cycle(self, tick, at=None):
        at = self.now if at is None else at
        with patch('time.time', return_value=at):
            self.stream.update(at)
            self.collector.cycle(tick)

    def buy(self):
        self.cycle(3)
        self.cycle(4, self.now + 20)
        account = self.collector.s['accounts'][P['wallets'][0]['address']]
        self.assertEqual(len(account['ledger']), 1)
        self.assertEqual(account['ledger'][0]['action'], 'BUY')
        return account

    def saved(self):
        run.seal(self.journal, self.collector.s, self.plan, P)
        return verify(self.root)

    def test_end_to_end_buy_capture_seal_restore_and_independent_reexecution(self):
        account = self.buy()
        result = self.saved()
        self.assertEqual(result['paper_fills_reexecuted_from_captured_books'], 1)
        self.assertTrue(result['cash_inventory_market_pnl_and_raw_ledger_equal'])
        self.assertEqual(result['evaluation']['accounts'][0]['open_distinct_markets'], 1)
        self.assertIsNone(result['evaluation']['accounts'][0]['total_account_profit_including_unresolved'])
        self.assertEqual(core.MODEL.number(account['cash']), core.MODEL.number('993.73'))

    def test_us_settlement_survives_foreign_positions_endpoint_failure(self):
        account = self.buy()
        self.collector.net.resolved = True
        self.collector.net.positions_fail = True
        self.collector.us_cache.clear()
        self.cycle(5, self.now + 40)
        self.assertEqual(account['ledger'][-1]['action'], 'SETTLE')
        result = self.saved()
        self.assertEqual(result['us_settlements_replayed'], 1)
        self.assertEqual(result['evaluation']['accounts'][0]['completed_distinct_markets'], 1)

    def test_earlier_sell_cannot_start_observation_delay_for_later_buy(self):
        network = self.collector.net
        network.buy['side'] = 'SELL'
        self.cycle(3)
        self.cycle(4, self.now + 20)
        account = self.collector.s['accounts'][P['wallets'][0]['address']]
        self.assertFalse(account['ledger'])
        network.buy = {**network.buy, 'side': 'BUY', 'timestamp': self.now + 30,
                       'transaction_hash': 'fixture-later-buy'}
        network.buy_at = self.now + 30
        self.cycle(5, self.now + 40)
        self.assertFalse(account['ledger'])
        self.cycle(6, self.now + 60)
        self.assertEqual(len(account['ledger']), 1)
        self.assertEqual(account['ledger'][0]['signal_first_seen_at'], self.now + 40)
        self.assertEqual(self.saved()['paper_fills_reexecuted_from_captured_books'], 1)

    def test_same_timestamp_buy_evidence_matches_the_price_gated_execution(self):
        network = self.collector.net
        network.extra_buys = [{**network.buy, 'price': '.50',
                               'transaction_hash': 'fixture-second-same-timestamp'}]
        account = self.buy()
        self.assertEqual(account['ledger'][0]['source_execution']['price'], '.60')
        self.assertEqual(account['ledger'][0]['source_execution']['transaction_hash'], 'fixture-transaction')
        self.assertEqual(self.saved()['paper_fills_reexecuted_from_captured_books'], 1)

    def test_existing_holdings_or_consumed_buy_do_not_create_new_entries(self):
        account = self.buy()
        self.cycle(5, self.now + 40)
        self.assertEqual(len(account['ledger']), 1)

    def test_closed_source_metadata_is_found_but_never_used_as_us_settlement(self):
        account = self.buy()
        self.collector.net.foreign_closed = True
        self.collector.source_cache.clear()
        with patch('time.time', return_value=self.now + 40):
            self.assertTrue(self.collector.source_market(FIXTURE['source']['conditionId'])['closed'])
        self.cycle(5, self.now + 40)
        self.assertEqual(len(account['ledger']), 1)
        self.assertGreater(core.MODEL.number(account['positions'][FIXTURE['source']['conditionId']]['quantity']), 0)

    def test_independent_replay_rejects_stale_http_used_for_a_fill(self):
        self.collector.net.stale_http = True
        self.buy()
        with self.assertRaisesRegex(ValueError, 'unqualified_used_http_evidence'):
            self.saved()

    def test_preparation_sample_saves_observation_time_and_stale_result(self):
        self.stream.update(self.now)
        with patch('time.time', return_value=self.now + 80):
            result = run.capture_preparation_sample(self.stream, self.journal,
                                                   [{'market_slug': FIXTURE['us']['slug']}])
        self.assertFalse(result[FIXTURE['us']['slug']]['usable'])
        row = self.journal.rows[-1]
        self.assertEqual(row['kind'], 'preparation_stream_sample')
        self.assertEqual(row['payload'], {'observed_at': self.now + 80, 'markets': result})

    def test_crash_before_cycle_commit_discards_only_uncommitted_state(self):
        self.buy()
        old = copy.deepcopy(self.collector.committed)
        self.collector.s['accounts'][P['wallets'][0]['address']]['cash'] = '1'
        self.collector.rollback_incomplete_cycle()
        self.assertEqual(self.collector.s, old)
        self.assertEqual(core.replay(self.journal.rows, P), old)

    def test_mutating_account_does_not_mutate_hashed_initial_wal_record(self):
        self.cycle(3)
        self.saved()
        core.verify_checkpoints(self.root)

    def test_restart_keeps_exact_cash_positions_pending_signals_and_clock(self):
        self.buy()
        self.saved()
        expected = core.replay(self.journal.rows, P)
        self.journal.close()
        self.journal = core.PaperJournal(self.root, resume=True)
        self.assertEqual(core.replay(self.journal.rows, P), expected)

    def test_stale_stream_book_does_not_fill_or_count_as_mark(self):
        self.cycle(3)
        with patch('time.time', return_value=self.now + 80):
            self.collector.cycle(7)
        self.assertFalse(self.collector.s['accounts'][P['wallets'][0]['address']]['ledger'])

    def test_missed_exposed_ticks_count_even_when_current_tick_settles(self):
        account = self.buy()
        before = account['held_mark_planned_ticks']
        self.collector.net.resolved = True
        self.collector.us_cache.clear()
        self.cycle(9, self.now + 120)
        self.assertEqual(account['held_mark_planned_ticks'] - before, 5)

    def test_tampered_published_body_is_rejected(self):
        self.buy()
        self.saved()
        path = next((self.root / 'bodies').glob('*.xz'))
        path.write_bytes(b'tampered-fixture')
        with self.assertRaises(ValueError):
            verify(self.root)

    def test_wrong_payout_orientation_or_start_is_rejected(self):
        mapping = core.MODEL.associate(FIXTURE['source'], FIXTURE['us'], P)
        target = copy.deepcopy(FIXTURE['us'])
        for side in target['marketSides']:
            side['long'] = not side['long']
        with self.assertRaisesRegex(ValueError, 'orientation'):
            core.verify_target_identity(mapping, target)

    def test_missing_raw_fill_is_rejected_not_silently_repaired(self):
        self.buy()
        rows = copy.deepcopy(self.journal.rows)
        for row in reversed(rows):
            if row['kind'] == 'paper_commit' and any(e['kind'] == 'paper_fill' for e in row['payload']['events']):
                row['payload']['events'] = []
                break
        with self.assertRaisesRegex(ValueError, 'ledger_mismatch'):
            core.replay(rows, P)

    def test_no_qualifications_means_no_paper_epoch_or_fills(self):
        with self.assertRaises((ValueError, FileNotFoundError)):
            run.require_qualification(self.root / 'not-qualified')

    def test_state_patch_round_trip(self):
        old = {'ledger': [1], 'dict': {'a': 1, 'remove': 2}}
        new = {'ledger': [1, 2], 'dict': {'a': 3, 'new': 4}}
        self.assertEqual(core.patched(old, core.delta(old, new)), new)

    def test_rewinding_tick_is_rejected(self):
        self.cycle(3)
        with self.assertRaisesRegex(ValueError, 'rewound'):
            self.collector.cycle(3)

    def test_partial_unacknowledged_wal_tail_is_preserved_without_rewinding_ledger(self):
        self.buy()
        expected = copy.deepcopy(self.collector.committed)
        self.journal.close()
        with (self.root / 'events.jsonl').open('ab') as out:
            out.write(b'{"partial-fixture')
        self.journal = core.PaperJournal(self.root, resume=True)
        self.assertEqual(core.replay(self.journal.rows, P), expected)
        self.assertEqual(len(list(self.root.glob('unacknowledged-tail-*.bin'))), 1)

    def test_corrupt_complete_wal_row_is_not_discarded_or_rewound(self):
        self.journal.close()
        with (self.root / 'events.jsonl').open('ab') as out:
            out.write(b'{"corrupt-complete-fixture":true}\n')
        with self.assertRaises((ValueError, KeyError)):
            core.PaperJournal(self.root, resume=True)

    def test_missing_exposed_marks_cannot_be_hidden_by_later_flat_ticks(self):
        account = self.buy()
        account.update(held_mark_planned_ticks=100, held_mark_complete_ticks=50,
            scheduled_complete_mark_ticks=10000, complete_mark_checks=10000, mark_checks=10000)
        account['positions'][self.collector.net.buy['condition_id']]['quantity'] = '0'
        self.collector.s['terminal'] = True
        self.assertEqual(core.evaluation(self.collector.s, P)['accounts'][0]['status'], 'INSUFFICIENT_TRADES/COVERAGE')

    def test_absent_observations_are_not_zero_return_claims(self):
        result = core.evaluation(self.state, P)
        for account in result['accounts']:
            self.assertIsNone(account['completed_net_after_modeled_fees_usd'])

    def test_drain_keeps_bounded_horizon_and_open_inventory(self):
        account = self.buy()
        hard_stop = self.collector.s['hard_stop']
        self.cycle(20000, hard_stop + 1)
        self.assertTrue(self.collector.s['terminal'])
        self.assertEqual(self.collector.s['hard_stop'], hard_stop)
        self.assertGreater(core.MODEL.number(account['positions'][self.collector.net.buy['condition_id']]['quantity']), 0)
        self.assertEqual(core.evaluation(self.collector.s, P)['accounts'][0]['status'], 'UNRESOLVED_SETTLEMENTS')

    def test_publication_permission_denial_is_not_retried(self):
        from publication import PublicationError
        with patch.dict('os.environ', {'GH_TOKEN': 'unit-test-fixture-only'}):
            mirror = run.PaperMirror('12345678901', 'a' * 40, self.root)
            with patch.object(run.GitMirror, 'request', side_effect=PublicationError('denied',
                {'status': 403, 'classification': 'http_rejection'})) as request:
                for _ in range(2):
                    with self.assertRaises(PermissionError):
                        mirror.request('/git/ref/heads/fixture')
                self.assertEqual(request.call_count, 1)

    def test_explicit_rate_limit_is_not_misclassified_as_permission_denial(self):
        from publication import PublicationError
        with patch.dict('os.environ', {'GH_TOKEN': 'unit-test-fixture-only'}):
            mirror = run.PaperMirror('12345678901', 'a' * 40, self.root)
            with patch.object(run.GitMirror, 'request', side_effect=PublicationError('limited',
                {'status': 403, 'classification': 'rate_limit'})):
                with self.assertRaises(PublicationError):
                    mirror.request('/git/ref/heads/fixture')
                self.assertFalse(mirror.denied)

    def test_incomplete_newest_backup_never_falls_back_to_older_backup(self):
        from types import SimpleNamespace
        backups = Path(self.temp.name) / 'backups'
        for number in ('00', '01'):
            (backups / ('pmus-unified-12345678901-1-' + number)).mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'incomplete_latest_backup'):
            run.recover(SimpleNamespace(source=backups, output=Path(self.temp.name) / 'recovery',
                run_id='12345678901', code_sha='a' * 40))

    def test_storage_failure_does_not_erase_acknowledged_inventory(self):
        self.buy()
        expected = copy.deepcopy(self.collector.committed)
        self.journal.limit = self.journal.total
        with self.assertRaisesRegex(RuntimeError, 'evidence_limit'):
            self.collector.commit()
        self.collector.rollback_incomplete_cycle()
        self.assertEqual(core.replay(self.journal.rows, P), expected)

    def test_protocol_preserves_all_frozen_trading_and_screen_parameters(self):
        original = json.loads((core.REFERENCE / 'protocol.json').read_bytes())
        for name in ('wallets', 'entry_collection_hours', 'maximum_settlement_drain_hours',
                     'starting_capital_usd', 'maximum_contracts_per_market', 'maximum_open_markets_per_account',
                     'taker_fee_coefficient', 'stress_cost_per_contract_per_trade', 'maximum_worse_entry_price',
                     'minimum_observation_delay_seconds', 'maximum_signal_age_seconds', 'maximum_book_age_seconds',
                     'minimum_completed_distinct_markets', 'minimum_coverage', 'maximum_drawdown_fraction',
                     'bootstrap_seed', 'bootstrap_samples', 'position_policy', 'us_settlement_policy', 'status_precedence'):
            self.assertEqual(P[name], original[name], name)

    def test_prepared_collector_code_and_workflow_bundle_is_deterministic(self):
        self.assertEqual(run.bundle_digest(), run.bundle_digest())
        self.assertEqual(len(run.bundle_digest()), 64)

    def test_dependency_lock_is_part_of_the_qualified_code_bundle(self):
        original = Path.read_bytes
        before = run.bundle_digest()
        def changed(path):
            value = original(path)
            return value + b'\n# changed dependency\n' if path.name == 'requirements-stream.txt' else value
        with patch.object(Path, 'read_bytes', changed):
            self.assertNotEqual(run.bundle_digest(), before)

    def test_single_workflow_has_explicit_order_and_bounded_segments(self):
        repo = core.ROOT.parents[1]
        text = (repo / '.github/workflows/pmus-four-wallet-unified-20261022.yml').read_text()
        for number in range(20):
            name = 'collect_' + str(number).zfill(2)
            self.assertEqual(text.count('  ' + name + ':'), 1)
            if number:
                self.assertIn('needs: [verify, collect_' + str(number - 1).zfill(2) + ']', text)
        segment = (repo / '.github/workflows/pmus-four-wallet-unified-segment-20261022.yml').read_text()
        self.assertIn('timeout-minutes: 330', segment)
        self.assertIn('--seconds 18000', segment)
        self.assertIn('runs-on: ubuntu-latest', segment)
        self.assertNotIn('secrets: inherit', text)

    def test_initial_launch_is_preparation_not_paper_entries(self):
        launch = json.loads((core.ROOT / 'launch.json').read_bytes())
        self.assertEqual(launch['mode'], 'prepare')


if __name__ == '__main__':
    unittest.main()
