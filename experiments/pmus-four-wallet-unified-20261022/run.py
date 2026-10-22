#!/usr/bin/env python3
"""One workflow: readiness -> paper collection -> US drain -> verified evaluation."""
from __future__ import annotations
import argparse
import base64
import concurrent.futures
import copy
import hashlib
import json
import math
import os
import re
import shutil
import signal
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from core import (ROOT, MODEL, PaperJournal, DynamicStream, IntegratedCollector, CollectorLog,
                  StrictNetwork, atomic_write, canonical, digest, evaluation, frozen,
                  initial_state, protocol, replay, verify_checkpoints)
from core import render_report
from publication import GitMirror, PublicationError, NoRedirect
from reliability_runner import BackgroundMirror
from verify import verify

READINESS = ROOT.parent / 'pmus-paper-readiness-20261022'
sys.path.insert(0, str(READINESS))
import readiness
CONTRACT = '74432bb54c13637cc2bcc3ec3096b910ac0c5b4e3f12aaccaf9db44a4d8166d7'


class PaperMirror(GitMirror):
    def __init__(self, run_id, code_sha, root):
        super().__init__(run_id, code_sha, root)
        self.branch = 'research/pmus-four-wallet-unified-state-20261022'
        self.folder = 'paper-results/' + protocol()['study_id'] + '/'
        self.denied, self.last_ack_at = False, time.time()

    def request(self, *args, **kwargs):
        if self.denied:
            raise PermissionError('checkpoint_permission_denied_no_retry')
        try:
            return super().request(*args, **kwargs)
        except PublicationError as error:
            detail = error.details
            if detail.get('status') in (401, 403) and detail.get('classification') != 'rate_limit':
                self.denied = True
                raise PermissionError('checkpoint_permission_denied_no_retry') from None
            raise

    def sync(self, journal):
        result = super().sync(journal)
        if result:
            self.last_ack_at = time.time()
        return result


def bundle_digest():
    repo = ROOT.parents[1]
    files = []
    for folder in (ROOT, ROOT.parent / 'pmus-data-reliability-20261018',
                   ROOT.parent / 'pmus-four-wallet-20261018', READINESS):
        files.extend(p for p in folder.iterdir() if p.suffix == '.py' or p.name in ('protocol.json', 'requirements.json'))
    files.extend((repo / '.github/workflows').glob('pmus-four-wallet-unified-*.yml'))
    return digest({str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)})


def require_qualification(folder):
    folder = Path(folder)
    data = (READINESS / 'requirements.json').read_bytes()
    if hashlib.sha256(data).hexdigest() != CONTRACT:
        raise ValueError('readiness_contract_changed')
    req = json.loads(data)
    req['requirements_sha256'] = CONTRACT
    packet = json.loads((folder / 'packet.json').read_bytes())
    if packet.get('code_bundle_sha256') != bundle_digest():
        raise ValueError('prepared_code_or_workflow_changed_since_readiness_review')
    result = readiness.assess(req, packet, folder)
    if not result['launch_ready']:
        raise ValueError('paper_launch_not_ready:' + ','.join(result['blockers']))
    return packet


def seal(journal, state, plan, p, segment_complete=False):
    result = {'schema': 1, 'mode': 'collect', 'run_id': plan['run_id'], 'code_sha': plan['code_sha'],
        'segment': state['segment'], 'segment_complete': segment_complete,
        'evaluation': evaluation(state, p), 'wal_bytes': journal.total,
        'compressed_body_bytes': journal.body_total,
        'raw_seq': journal.seq, 'raw_hash': journal.head,
        'real_orders': 0, 'private_account_requests': 0}
    result['report_markdown'] = render_report(result['evaluation'], plan['run_id'])
    journal.seal(result)
    atomic_write(journal.root / 'EVALUATION.md', result['report_markdown'].encode())
    return result


def remote_round_trip(mirror, expected_evaluation=None):
    """Observe immutable Git blob identities, then GET only those public immutable bytes."""
    ref = mirror.ref()
    commit_sha = ref['object']['sha']
    commit = mirror.request('/git/commits/' + commit_sha)
    tree = mirror.request('/git/trees/' + commit['tree']['sha'] + '?recursive=1')
    if tree.get('truncated'):
        raise ValueError('truncated_remote_evidence_tree')
    items = [i for i in tree['tree'] if i['type'] == 'blob' and i['path'].startswith(mirror.folder)]
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        def download(item):
            name = item['path'][len(mirror.folder):]
            if not re.fullmatch(r'(?:plan.json|summary.json|bodies/[0-9a-f]{64}\.xz|checkpoints/[0-9]{6}/(?:manifest.json|raw.jsonl.xz|summary.json))', name):
                raise ValueError('unexpected_remote_evidence_path')
            url = 'https://raw.githubusercontent.com/futuremvp427/source-to-sim/' + commit_sha + '/' + item['path']
            request = urllib.request.Request(url, method='GET', headers={'User-Agent': 'pmus-paper-readonly-verifier'})
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
                data = response.read(8 * 1024**2 + 1)
            if (len(data) != item['size'] or hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != item['sha']):
                raise ValueError('remote_git_blob_identity_mismatch')
            atomic_write(root / name, data, immutable=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(download, items))
        result = verify(root)
        if expected_evaluation is not None and result['evaluation'] != expected_evaluation:
            raise ValueError('remote_round_trip_evaluation_mismatch')
        return {'commit_sha': commit_sha, 'git_blob_identities_verified': len(items), **result}


def warnings(state, journal, p):
    now, start = state['last_cycle_at'], state['started_at']
    elapsed = min(now, state['entry_end']) - start
    remaining = max(0, state['entry_end'] - now)
    values = []
    for a in state['accounts'].values():
        if a['covered_seconds'] + remaining < .95 * (state['entry_end'] - start):
            values.append({'id': 'irrecoverable_source_coverage:' + a['wallet'], 'wallet': a['wallet']})
        done = MODEL.metrics(a, state['mappings'], p, now, start, state['entry_end'])['completed_distinct_markets']
        if elapsed >= 6 * 3600 and done * 48 * 3600 / max(1, elapsed) < 30:
            values.append({'id': 'sample_pace_below_minimum:' + a['wallet'], 'wallet': a['wallet'],
                'completed': done, 'linear_pace_is_not_a_guarantee_or_impossibility_proof': True})
        for c, pos in a['positions'].items():
            if MODEL.number(pos['quantity']) > 0 and state['mappings'][c]['start_at'] >= state['hard_stop']:
                values.append({'id': 'held_event_after_hard_stop:' + a['wallet'] + ':' + c, 'wallet': a['wallet']})
    if now > start + 600 and journal.total / max(1, now - start) * (state['hard_stop'] - start) > .8 * journal.limit:
        values.append({'id': 'projected_wal_budget_risk', 'current_bytes': journal.total,
                       'budget_bytes': journal.limit})
    return values


def collect(args):
    p = protocol()
    stop = __import__('threading').Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    journal = stream = background = collector = None
    failure = None
    try:
        packet = require_qualification(ROOT / 'qualification')
        if args.segment == 0:
            if args.output.exists():
                raise ValueError('duplicate_paper_initialization_refused')
            mirror = PaperMirror(args.run_id, args.code_sha, args.output)
            if mirror.ref():
                raise ValueError('study_already_has_state_no_second_epoch')
            journal = PaperJournal(args.output)
            now = time.time()
            state = initial_state(p, args.code_sha, now)
            plan = {'run_id': args.run_id, 'code_sha': args.code_sha, 'study_id': p['study_id'],
                'protocol_sha256': state['protocol_sha256'], 'started_at': now,
                'entry_end': state['entry_end'], 'hard_stop': state['hard_stop'],
                'readiness_packet_sha256': digest(packet), 'code_bundle_sha256': bundle_digest(),
                'live_gate_run_id': packet['live_gate']['run_id']}
            atomic_write(args.output / 'plan.json', canonical(plan) + b'\n', immutable=True)
            journal.add('paper_initial_state', state)
        else:
            if not args.output.exists():
                raise ValueError('latest_same_run_backup_required_no_older_checkpoint_fallback')
            journal = PaperJournal(args.output, resume=True)
            plan = json.loads((args.output / 'plan.json').read_bytes())
            if plan['run_id'] != args.run_id or plan['code_sha'] != args.code_sha:
                raise ValueError('paper_resume_run_or_code_mismatch')
            state = replay(journal.rows, p)
            if state['segment'] != args.segment - 1 or state['segment_complete'] is not True:
                raise ValueError('previous_segment_not_cleanly_completed')
            mirror = PaperMirror(args.run_id, args.code_sha, args.output)
        stream = DynamicStream(journal)
        collector = IntegratedCollector(state, p, journal, stream)
        collector.s.update(segment=args.segment, segment_complete=False)
        collector.commit()
        background = BackgroundMirror(mirror, journal)
        if not collector.s['terminal'] and time.time() < state['hard_stop']:
            stream.start()
        end = min(state['hard_stop'], time.time() + args.seconds)
        next_seal = time.time()
        announced = set()
        while time.time() < end and not collector.s['terminal'] and not stop.is_set():
            if stream.fatal:
                raise PermissionError(stream.fatal)
            background.poll()
            if time.time() - mirror.last_ack_at > 1800:
                collector.s['entries_stopped_reason'] = 'publication_acknowledgement_older_than_30_minutes'
                journal.add('evaluation_risk', {'id': 'publication_stale_over_30_minutes', 'at': time.time()})
            tick = max(collector.s['last_tick'] + 1, math.ceil((time.time() - state['started_at']) / p['poll_seconds']))
            due = state['started_at'] + tick * p['poll_seconds']
            if stop.wait(max(0, min(due, end) - time.time())) or time.time() >= end:
                break
            collector.cycle(tick)
            for warning in warnings(collector.s, journal, p):
                if warning['id'] not in announced:
                    journal.add('evaluation_risk', {**warning, 'at': time.time()})
                    print('PAPER_EVALUATION_RISK=' + json.dumps(warning), flush=True)
                    announced.add(warning['id'])
            if time.time() >= next_seal or collector.s['terminal']:
                seal(journal, collector.s, plan, p)
                background.submit()
                next_seal = time.time() + p['checkpoint_seconds']
        if stop.is_set() and time.time() < end - 30 and not collector.s['terminal']:
            raise RuntimeError('runner_interrupted_before_segment_boundary')
        if time.time() >= collector.s['hard_stop']:
            collector.s['terminal'] = True
            collector.s['terminal_declared_at'] = time.time()
    except Exception as error:
        # Never commit only half a cycle or claim its buffered fills were completed.
        if collector:
            collector.rollback_incomplete_cycle()
        failure = str(error) if isinstance(error, (ValueError, PermissionError)) else type(error).__name__
    finally:
        if stream:
            try:
                stream.close()
            except Exception:
                failure = failure or 'stream_shutdown_failed'
        if collector and journal:
            collector.s['segment_complete'] = failure is None
            if failure:
                collector.s['entries_stopped_reason'] = failure
            collector.commit()
            journal.add('segment_finished', {'segment': args.segment, 'at': time.time(), 'failure': failure})
            result = seal(journal, collector.s, plan, p, segment_complete=failure is None)
            if background:
                try:
                    background.close()
                except Exception as error:
                    failure = failure or type(error).__name__
            try:
                mirror.sync(journal)
                local = verify(args.output)
                if collector.s['terminal']:
                    saved_proof = args.output / 'terminal-verification.json'
                    cached = json.loads(saved_proof.read_bytes()) if saved_proof.exists() else None
                    if cached is None or cached.get('evaluation') != local['evaluation']:
                        proof = remote_round_trip(mirror, local['evaluation'])
                        atomic_write(saved_proof, canonical(proof) + b'\n')
                print('PAPER_INTEGRATED_RESULT=' + json.dumps({'failure': failure, **result}), flush=True)
            except Exception as error:
                failure = failure or type(error).__name__
                print('PAPER_SAVE_OR_VERIFICATION_BLOCKER=' + failure, flush=True)
            journal.close()
        elif journal:
            journal.close()
    if failure:
        print('PAPER_BLOCKER=' + failure, flush=True)
    return 1 if failure else 0


def prepare(args):
    """Read-only bounded sample audit. No paper account or entry epoch is initialized."""
    p, journal = protocol(), PaperJournal(args.output)
    stats = {'http_calls': 0, 'http_errors': 0}
    log = CollectorLog(journal, stats)
    net = StrictNetwork(p, log)
    plan = {'mode': 'prepare', 'run_id': args.run_id, 'code_sha': args.code_sha,
            'started_at': time.time(), 'code_bundle_sha256': bundle_digest()}
    atomic_write(args.output / 'plan.json', canonical(plan) + b'\n', immutable=True)
    summary = {'mode': 'prepare', 'run_id': args.run_id, 'code_sha': args.code_sha,
        'paper_entries': 0, 'paper_epoch_initialized': False, 'real_orders': 0,
        'private_account_requests': 0, 'launch_ready': False, 'wallets': {},
        'reason': 'Actual live gate and independently reviewed full readiness evidence remain required.'}
    stream = None
    try:
        stream = DynamicStream(journal)
        watch = json.loads((ROOT.parent / 'pmus-live-gate-20261022/watch.json').read_bytes())
        for market in watch['markets']:
            stream.ensure(market['market_slug'])
        stream.start()
        now = int(time.time())
        joined = {}
        for w in p['wallets']:
            rows, at = frozen.pages(net, 'https://data-api.polymarket.com/v2/trades',
                {'user': w['address'], 'taker_only': 'false', 'limit': 1000, 'start': now - 172800, 'end': now}, w['address'])
            if any(not now - 172800 <= float(r['timestamp']) <= now for r in rows):
                raise ValueError('preparation_source_window_filter_violation')
            eligible = {r['condition_id'] for r in rows if r.get('side') == 'BUY'
                and r.get('slug') == r.get('event_slug') and MODEL.GAME.fullmatch(r.get('slug', ''))}
            matched, rejected = [], {}
            for condition in sorted(eligible):
                if time.time() - plan['started_at'] > 900:
                    rejected[condition] = 'bounded_mapping_audit_incomplete'
                    continue
                if condition not in joined:
                    try:
                        source, _ = net.get(frozen.query('https://gamma-api.polymarket.com/markets', {'condition_ids': condition}))
                        if not isinstance(source, list) or len(source) != 1 or source[0]['conditionId'] != condition:
                            raise ValueError('source_market_identity')
                        target = None
                        for slug in frozen.destination_slugs(source[0], p):
                            try:
                                body, _ = net.get('https://gateway.polymarket.us/v1/market/slug/' + slug)
                                target = body['market']
                                break
                            except ValueError as error:
                                if str(error) != 'HTTP 404':
                                    raise
                        if target is None:
                            raise ValueError('no_verified_us_counterpart')
                        joined[condition] = {'mapping': MODEL.associate(source[0], target, p), 'error': None}
                    except ValueError as error:
                        joined[condition] = {'mapping': None, 'error': str(error)}
                item = joined[condition]
                if item['mapping']:
                    matched.append(item['mapping'])
                else:
                    rejected[condition] = item['error']
            summary['wallets'][w['address']] = {'name': w['name'], 'last_successful_poll': at,
                'latest_returned_execution': max((float(r['timestamp']) for r in rows), default=None),
                'executions_returned': len(rows), 'candidate_distinct_source_moneylines': len(eligible),
                'candidate_conditions': sorted(eligible), 'complete_48h_read': True,
                'verified_us_distinct_markets': len({m['us_slug'] for m in matched}),
                'verified_us_associations': matched, 'rejected_or_unverified_conditions': rejected,
                'recent_48h_mapped_event_count_reaches_30': len({m['us_slug'] for m in matched}) >= 30,
                'credible_completed_market_forecast': None,
                'known_starts_after_hypothetical_drain_end': [m['us_slug'] for m in matched if m['start_at'] >= now + 96 * 3600],
                'candidates_are_not_fills_or_returns_or_guaranteed_future_activity': True}
        summary['actual_read_finished_at'] = time.time()
        summary['sample_plan_needs_full_us_mapping_and_settlement_date_review'] = True
        samples = []
        for index in range(3):
            if stream.fatal:
                raise PermissionError(stream.fatal)
            stream.stop.wait(10)
            samples.append({m['market_slug']: stream.state.snapshot(m['market_slug'], time.time())
                            for m in watch['markets']})
        summary['prepared_dynamic_stream_fresh_samples'] = {
            m['market_slug']: sum(bool(t[m['market_slug']].get('usable')) for t in samples)
            for m in watch['markets']}
        summary['dynamic_stream_pregame_smoke_passed'] = all(v == 3 for v in summary['prepared_dynamic_stream_fresh_samples'].values())
        summary['pregame_smoke_is_not_actual_live_gate_or_profitability'] = True
        stream.close()
        stream = None
        journal.add('preparation_audit', summary)
        journal.seal(summary)
        mirror = GitMirror(args.run_id, args.code_sha, args.output)
        mirror.sync(journal)
        summary['published_commit'] = mirror.head
        print('UNIFIED_PREPARATION=' + json.dumps(summary), flush=True)
    finally:
        if stream:
            stream.close()
        journal.close()
    return 0


def recover(args):
    choices = []
    if (args.source / 'plan.json').is_file():
        choices.append((args.segment - 1, 1, args.source))
    elif args.source.exists():
        for folder in args.source.iterdir():
            match = re.fullmatch(r'pmus-unified-' + re.escape(args.run_id) + r'-([0-9]+)-([0-9]{2})', folder.name)
            if match and folder.is_dir() and not folder.is_symlink():
                choices.append((int(match[2]), int(match[1]), folder))
    if not choices:
        raise ValueError('missing_latest_same_run_backup_refuse_rewind')
    _, _, selected = max(choices)
    for name in ('events.jsonl', 'plan.json', 'publication.json'):
        if not (selected / name).is_file() or (selected / name).is_symlink():
            raise ValueError('incomplete_latest_backup_refuse_older_backup')
    plan = json.loads((selected / 'plan.json').read_bytes())
    if plan['run_id'] != args.run_id or plan['code_sha'] != args.code_sha:
        raise ValueError('backup_identity_mismatch')
    shutil.copytree(selected, args.output)
    journal = PaperJournal(args.output, resume=True)
    replay(journal.rows, protocol())
    journal.close()
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('prepare', 'collect', 'recover', 'evaluate'), required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--code-sha', required=True)
    parser.add_argument('--segment', type=int, default=0)
    parser.add_argument('--seconds', type=int, default=18000)
    parser.add_argument('--approved-paper-only', action='store_true')
    args = parser.parse_args()
    if (not args.approved_paper_only or not re.fullmatch(r'[0-9]{6,20}', args.run_id)
            or not re.fullmatch(r'[0-9a-f]{40}', args.code_sha) or not 0 <= args.segment < 20
            or not 20 <= args.seconds <= 18000):
        parser.error('explicit_paper_authority_and_bounded_identity_required')
    if args.mode == 'evaluate':
        print(json.dumps(verify(args.output), indent=2))
        return 0
    return {'collect': collect, 'prepare': prepare, 'recover': recover}[args.mode](args)


if __name__ == '__main__':
    raise SystemExit(main())
