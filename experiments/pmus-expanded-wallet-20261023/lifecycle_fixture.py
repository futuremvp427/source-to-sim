#!/usr/bin/env python3
"""Synthetic lifecycle proof through the EXISTING pinned collector and evaluator.

No public network calls, credentials, real orders, forward-study epoch or launch.
The only generated fills are explicitly labelled test fixtures.
"""
import argparse
import base64
import copy
import hashlib
import json
import math
import sys
import tarfile
import time
import urllib.parse
from email.utils import formatdate
from pathlib import Path
from unittest.mock import patch

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code-root', type=Path, required=True)
    parser.add_argument('--code-sha', required=True)
    parser.add_argument('--run-id', default='SYNTHETIC-LIFECYCLE-FIXTURE-NOT-A-STUDY-RUN')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if len(args.code_sha) != 40 or any(c not in '0123456789abcdef' for c in args.code_sha):
        raise ValueError('invalid_immutable_code_commit')
    if args.output.exists():
        raise ValueError('refuse_existing_fixture_output')
    sys.path.insert(0, str(args.code_root / 'experiments/pmus-four-wallet-unified-20261022'))
    import core
    import run
    from verify import verify
    from test_unified import FakeStream, FIXTURE

    p = core.protocol()
    original_protocol = hashlib.sha256((core.ROOT / 'protocol.json').read_bytes()).hexdigest()
    assert p['study_id'] == 'pmus-expanded-wallet-forward-20261023-v1'
    assert len(p['wallets']) == 12
    args.output.mkdir(parents=True)
    root = args.output / 'fixture-journal'
    journal = core.PaperJournal(root)
    now = core.MODEL.stamp(FIXTURE['us']['gameStartTime']) - 3600
    state = core.initial_state(p, args.code_sha, now - 60)
    state['synthetic_fixture_only'] = True
    plan = {'run_id': args.run_id, 'code_sha': args.code_sha,
            'protocol_sha256': original_protocol, 'synthetic_fixture_only': True,
            'actual_paper_start': False, 'real_orders': 0}
    core.atomic_write(root / 'plan.json', core.canonical(plan), immutable=True)
    journal.add('paper_initial_state', state)
    stream = FakeStream(journal)
    collector = core.IntegratedCollector(state, p, journal, stream)
    token_ids = json.loads(FIXTURE['source']['clobTokenIds'])
    outcomes = json.loads(FIXTURE['source']['outcomes'])
    wallet = p['wallets'][0]['address']

    class FixtureNetwork:
        def __init__(self, log):
            self.journal, self.p = log, p
            self.resolved, self.positions_fail = False, False
            self.inventory = ['100', '0']
            self.last_event = now - 10
            self.trade = self.execution('BUY', 0, '100', now - 10, '.60')

        def execution(self, action, side, quantity, at, price):
            return {'proxy_wallet': wallet, 'timestamp': at, 'side': action,
                    'condition_id': FIXTURE['source']['conditionId'], 'token_id': token_ids[side],
                    'slug': FIXTURE['source']['slug'], 'event_slug': FIXTURE['source']['slug'],
                    'transaction_hash': 'SYNTHETIC-' + str(at), 'size': quantity, 'price': price}

        def get(self, url):
            u = urllib.parse.urlsplit(url)
            q = urllib.parse.parse_qs(u.query)
            at = time.time()
            if u.path == '/v2/trades':
                rows = [copy.deepcopy(self.trade)] if q['user'] == [wallet] else []
                body = {'data': rows, 'pagination': {'has_more': False}}
            elif u.path == '/v2/positions':
                if self.positions_fail:
                    raise ValueError('SYNTHETIC_foreign_positions_unavailable')
                rows = [{'proxy_wallet': q['user'][0], 'condition_id': FIXTURE['source']['conditionId'],
                         'token_id': token_ids[i], 'outcome': outcomes[i],
                         'current_size': quantity, 'last_event_at': self.last_event}
                        for i, quantity in enumerate(self.inventory)]
                body = {'data': rows, 'pagination': {'has_more': False}}
            elif u.netloc == 'gamma-api.polymarket.com':
                body = [copy.deepcopy(FIXTURE['source'])]
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
                raise AssertionError('Unexpected fixture request: ' + url)
            raw = core.canonical(body)
            self.journal.add('http', {'url': url, 'method': 'GET', 'authenticated': False,
                'sent_at': at, 'received_at': at, 'http_status': 200,
                'headers': {'date': formatdate(at, usegmt=True), 'age': '0'},
                'body_bytes': len(raw), 'body_sha256': hashlib.sha256(raw).hexdigest(),
                'raw_base64': base64.b64encode(raw).decode(), 'error': None})
            self.journal.state['http_calls'] += 1
            return body, at

    network = FixtureNetwork(collector.journal)
    collector.net = network
    stages = []

    def cycle(tick, at):
        with patch('time.time', return_value=at):
            stream.update(at)
            collector.cycle(tick)

    def checkpoint(name):
        run.seal(journal, collector.s, plan, p)
        result = verify(root)
        account = collector.s['accounts'][wallet]
        stages.append({'stage': name, 'fixture_only': True,
                       'ledger_actions': [r['action'] for r in account['ledger']],
                       'ledger_quantities': [r['quantity'] for r in account['ledger']],
                       'cash': account['cash'], 'verification': result})
        return account

    cycle(3, now)
    cycle(4, now + 20)
    account = checkpoint('initial_buy')
    assert [r['action'] for r in account['ledger']] == ['BUY']
    assert core.MODEL.number(account['positions'][network.trade['condition_id']]['quantity']) == 10

    network.inventory = ['50', '0']
    network.last_event = now + 30
    network.trade = network.execution('SELL', 0, '50', now + 30, '.59')
    cycle(5, now + 40)
    account = checkpoint('half_reduction')
    assert [r['action'] for r in account['ledger']] == ['BUY', 'SELL']
    assert core.MODEL.number(account['positions'][network.trade['condition_id']]['quantity']) == 5

    network.inventory = ['100', '0']
    network.last_event = now + 50
    network.trade = network.execution('BUY', 0, '50', now + 50, '.60')
    cycle(6, now + 60)
    assert len(account['ledger']) == 2, 'minimum observation delay was bypassed'
    cycle(7, now + 80)
    account = checkpoint('fresh_addition_after_observation_delay')
    assert [r['action'] for r in account['ledger']] == ['BUY', 'SELL', 'BUY']

    network.inventory = ['0', '100']
    network.last_event = now + 90
    network.trade = network.execution('BUY', 1, '100', now + 90, '.40')
    cycle(8, now + 100)
    assert [r['action'] for r in account['ledger']] == ['BUY', 'SELL', 'BUY', 'SELL']
    cycle(9, now + 120)
    account = checkpoint('close_then_fresh_opposite_buy')
    assert [r['action'] for r in account['ledger']] == ['BUY', 'SELL', 'BUY', 'SELL', 'BUY']

    before_restore = core.digest(collector.committed)
    journal.close()
    journal = core.PaperJournal(root, resume=True)
    restored = core.replay(journal.rows, p)
    assert core.digest(restored) == before_restore
    stream = FakeStream(journal)
    collector = core.IntegratedCollector(restored, p, journal, stream)
    network.journal = collector.journal
    collector.net = network
    network.resolved = True
    network.positions_fail = True
    cycle(10, now + 140)
    account = checkpoint('us_settlement_despite_foreign_positions_failure_after_restore')
    assert account['ledger'][-1]['action'] == 'SETTLE'
    assert core.MODEL.number(account['positions'][network.trade['condition_id']]['quantity']) == 0

    stop = collector.s['entry_end'] + 1
    cycle(math.ceil((stop - collector.s['started_at']) / p['poll_seconds']), stop)
    checkpoint('terminal_with_missing_scheduled_samples_preserved')
    assert collector.s['terminal']
    result = verify(root)
    assert result['paper_fills_reexecuted_from_captured_books'] == 5
    assert result['us_settlements_replayed'] == 1
    assert result['evaluation']['accounts'][0]['status'] == 'INSUFFICIENT_TRADES/COVERAGE'
    # Separate pure-evaluator projections exercise every terminal precedence.
    # They are NOT collector executions and never enter the fixture trade ledger.
    def projected_status(count=30, gain='1', stress='.1', held=False, drawdown='0', source=172800):
        a=core.MODEL.new_account('SYNTHETIC-POLICY-ONLY','fixture-policy-wallet','1000')
        a.update(covered_seconds=source,mark_checks=8640,complete_mark_checks=8640,max_drawdown_usd=drawdown)
        for i in range(count):
            a['games']['aec-synthetic-policy-'+str(i)]={'cash_delta':gain,'stress_cost':stress,
                'fees':'.1','bought':'10','sold':'0','settled':'10','entry_fills':1,'exit_fills':0}
        maps={}
        if held:
            a['positions']['synthetic-condition']={'side':0,'quantity':'10'}
            maps={'synthetic-condition':{'us_slug':'aec-synthetic-policy-0'}}
        return core.MODEL.metrics(a,maps,p,172800,0,172800,terminal=True)['status']
    projections={
        'open_over_all_other_failures':{'expected':'UNRESOLVED_SETTLEMENTS','actual':projected_status(count=1,held=True,source=0)},
        'small_sample_over_negative_net':{'expected':'INSUFFICIENT_TRADES/COVERAGE','actual':projected_status(count=29,gain='-1')},
        'coverage_over_negative_net':{'expected':'INSUFFICIENT_TRADES/COVERAGE','actual':projected_status(gain='-1',source=0)},
        'stress_cost_screen':{'expected':'FAILED_SCREEN','actual':projected_status(gain='.05',stress='.1')},
        'drawdown_screen':{'expected':'FAILED_SCREEN','actual':projected_status(drawdown='200.01')},
        'complete_positive_screen_only':{'expected':'PROMISING_SCREEN_ONLY','actual':projected_status()}}
    sys.path.insert(0,str(core.ROOT.parent/'pmus-paper-readiness-20261022'))
    from test_readiness import FrozenEvaluatorSmokeTests
    FrozenEvaluatorSmokeTests.setUpClass()
    smoke=FrozenEvaluatorSmokeTests();uncertain=smoke.account()
    for i in range(30):uncertain['games']['aec-fixture-'+str(i)]['cash_delta']='11' if i<15 else '-10'
    projections['positive_uncertain']={'expected':'POSITIVE_BUT_UNCERTAIN','actual':smoke.status(uncertain)}
    assert all(x['actual']==x['expected'] for x in projections.values())
    journal.add('synthetic_pure_evaluator_precedence_projections',{
        'synthetic_fixture_only':True,'not_collector_executions_or_wallet_returns':True,'cases':projections})
    run.seal(journal,collector.s,plan,p)
    result=verify(root)
    journal.close()
    summary = {'synthetic_fixture_only': True, 'not_live_or_profitability_evidence': True,
               'collector_code_commit': args.code_sha, 'protocol_sha256': original_protocol,
               'collector_bundle_sha256': run.bundle_digest(),
               'original_economic_rules_and_final_gates_unchanged': True, 'expanded_accounts': 12, 'actual_paper_epoch_initialized': False,
               'real_orders': 0, 'private_account_requests': 0, 'public_network_calls': 0,
               'buy_reduction_addition_flip_settlement_independently_replayed': True,
               'crash_resume_state_digest_equal': before_restore,
               'stages': stages, 'final_verification': result}
    (args.output / 'fixture-result.json').write_text(json.dumps(summary, indent=2) + '\n')
    files = []
    for path in sorted(root.rglob('*')):
        if path.is_file():
            data = path.read_bytes()
            files.append({'path': str(path.relative_to(root)), 'bytes': len(data),
                          'sha256': hashlib.sha256(data).hexdigest()})
    (args.output / 'fixture-files.json').write_text(json.dumps(files, indent=2) + '\n')
    with tarfile.open(args.output / 'fixture-journal.tar.xz', 'w:xz') as archive:
        for row in files:
            archive.add(root / row['path'], arcname=row['path'], recursive=False)
    print(json.dumps({'synthetic_fixture_only': True, 'fills': result['paper_fills_reexecuted_from_captured_books'],
                      'settlements': result['us_settlements_replayed'], 'checkpoints': result['checkpoints_verified'],
                      'status': result['evaluation']['accounts'][0]['status'], 'files': len(files)}))


if __name__ == '__main__':
    main()
