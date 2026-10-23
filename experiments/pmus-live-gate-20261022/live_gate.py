#!/usr/bin/env python3
"""A bounded live-book gate. No orders, private-account API or paper entries."""
from __future__ import annotations
import argparse
import base64
import collections
import concurrent.futures
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REFERENCE = ROOT.parent / 'pmus-four-wallet-20261018'
REPAIR = ROOT.parent / 'pmus-data-reliability-20261018'
sys.path.insert(0, str(REFERENCE))
import collector as frozen
sys.path.insert(0, str(REPAIR))
from durable import DurableJournal, atomic_write, verify_checkpoints
from publication import GitMirror
from probe import PublicClient, NoRedirect
from quality import MODEL, PROTOCOL, canonical, digest, transport
from reliability_runner import BackgroundMirror, ReconnectingStream, market_identity, observe

INTERVAL = 20
DURATION = 1800
EVENT = re.compile(r'^nhl-[a-z0-9]+-[a-z0-9]+-2026-10-22$')
EVENT_IDS = frozenset(m['event_id'] for m in json.loads((ROOT / 'watch.json').read_bytes())['markets'])
PHASE_BUDGET_SECONDS = 16


def verify_extra_http(rows):
    for row in rows:
        if row['kind'] not in ('event_http', 'source_http'):
            continue
        p = row['payload']
        body = base64.b64decode(p['raw_base64'], validate=True)
        if len(body) != p['body_bytes'] or hashlib.sha256(body).hexdigest() != p['body_sha256']:
            raise ValueError('supplemental_http_body_digest_mismatch')
        if p['method'] != 'GET' or p['authenticated'] is not False:
            raise ValueError('unexpected_request_authority')
        if row['kind'] == 'source_http' and not frozen.allowed(p['url']):
            raise ValueError('unapproved_source_endpoint')
        if row['kind'] == 'event_http' and not event_url_allowed(p['url']):
            raise ValueError('unapproved_event_endpoint')


def event_url_allowed(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or u.netloc != 'gateway.polymarket.us' or u.query or u.fragment:
        return False
    if u.path.startswith('/v1/events/slug/'):
        return EVENT.fullmatch(u.path[len('/v1/events/slug/'):]) is not None
    return u.path.startswith('/v1/events/') and u.path[len('/v1/events/'):] in EVENT_IDS


class EventClient:
    def __init__(self, journal):
        self.journal = journal

    def get(self, slug, event_id=None, deadline=None):
        url = 'https://gateway.polymarket.us/v1/events/' + ('slug/' + slug if event_id is None else str(event_id))
        if not event_url_allowed(url):
            raise ValueError('unapproved_event_endpoint')
        sent, data, status, headers, error = time.time(), b'', None, {}, None
        timeout = 8 if deadline is None else min(4, deadline - sent)
        if timeout <= 0:
            raise ValueError('phase_read_deadline_elapsed')
        try:
            request = urllib.request.Request(url, method='GET', headers={
                'User-Agent': 'pmus-live-gate/1.0', 'Accept': 'application/json',
                'Cache-Control': 'no-cache, max-age=0', 'Pragma': 'no-cache'})
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
                status, headers = response.status, dict(response.headers.items())
                data = response.read(2 * 1024**2 + 1)
        except urllib.error.HTTPError as exc:
            status, headers, error = exc.code, dict(exc.headers.items()), 'HTTP_' + str(exc.code)
            data = exc.read(2 * 1024**2 + 1)
        except Exception as exc:
            error = type(exc).__name__
        if len(data) > 2 * 1024**2:
            raise ValueError('event_response_size_bound')
        headers = {k.lower(): v for k, v in headers.items() if k.lower() in
            ('date', 'age', 'last-modified', 'etag', 'cache-control', 'retry-after')}
        row = {'url': url, 'method': 'GET', 'authenticated': False, 'sent_at': sent,
            'received_at': time.time(), 'status': status, 'headers': headers, 'error': error,
            'body_bytes': len(data), 'body_sha256': hashlib.sha256(data).hexdigest(),
            'raw_base64': base64.b64encode(data).decode()}
        reference = self.journal.add('event_http', row)
        if status in (401, 403):
            raise PermissionError('event_access_denied_' + str(status))
        try:
            body = json.loads(data)
        except (ValueError, UnicodeError):
            body = None
        return {**row, 'body': body, 'evidence': reference}

    def fresh(self, item, scheduled_at):
        """At most three public reads, all within the original scheduled tick.

        A cached slug response may be followed by the documented exact-ID route.
        If both routes are still cached, one retry may wait for the advertised
        TTL, but only inside a 16-second budget. No query nonce, new host,
        credentials, stale allowance, or retry after an access/rate-limit error.
        This returns HTTP evidence only; phase() must still certify live/open.
        """
        deadline = scheduled_at + PHASE_BUDGET_SECONDS
        attempts = []

        def read(by_id):
            response = self.get(item['event_slug'], event_id=item['event_id'] if by_id else None,
                                deadline=deadline)
            attempts.append(response['evidence'])
            return response

        def cached(response):
            issues, detail = transport(response, 20)
            # Fail closed on wrong identity, missing/invalid/future dates, access
            # denial, throttling and errors. These are never cache fallbacks.
            return (issues and set(issues) <= {'stale_http_cache'}
                    and not event_identity_issues(response, item))

        response = read(False)
        if cached(response) and time.time() + 1 < deadline:
            response = read(True)
            if cached(response):
                headers = {k.lower(): v for k, v in response['headers'].items()}
                match = re.search(r'(?:^|,)\s*max-age=(\d+)(?:\s*,|\s*$)', headers.get('cache-control', ''))
                if match:
                    ttl, age = int(match[1]), float(headers['age'])
                    delay = max(0, ttl - age) + .25
                    if 0 <= ttl <= 60 and time.time() + delay + 1 < deadline:
                        time.sleep(delay)
                        response = read(True)
        return {**response, 'attempt_evidence': attempts, 'scheduled_at': scheduled_at,
                'phase_read_deadline': deadline}


def event_identity_issues(response, item):
    issues = []
    try:
        event = response['body']['event']
        if (event.get('slug') != item['event_slug'] or str(event.get('id')) != item['event_id']
                or MODEL.stamp(event.get('startTime')) != item['start_at']):
            issues.append('event_identity_or_start_changed')
        markets = event.get('markets', [])
        market = [m for m in markets if isinstance(m, dict) and m.get('slug') == item['market_slug']]
        if len(market) != 1 or market_identity(market[0]) != item['market_identity']:
            issues.append('event_market_identity_changed')
    except (ValueError, TypeError, KeyError, AttributeError, ArithmeticError):
        issues.append('malformed_event_identity')
    return issues


def phase(response, item):
    issues, detail = transport(response, 20)
    issues.extend(event_identity_issues(response, item))
    body = response.get('body')
    event = body.get('event') if isinstance(body, dict) else None
    event = event if isinstance(event, dict) else {}
    # Explicit documented live flag; scheduled start and a nonempty score are NOT proof.
    if event.get('live') is not True or event.get('ended') is True:
        issues.append('official_live_flag_not_confirmed')
    if event.get('closed') is not False or event.get('active') is not True:
        issues.append('event_not_open_active')
    if response.get('phase_read_deadline') is not None and response['received_at'] > response['phase_read_deadline']:
        issues.append('phase_read_deadline_elapsed')
    return {'usable': not issues, 'issues': issues, 'live': event.get('live'),
        'ended': event.get('ended'), 'period': event.get('period'),
        'evidence': response['evidence'], 'received_at': response['received_at'],
        'transport': detail, 'attempt_evidence': response.get('attempt_evidence', [response['evidence']])}


class SourceLog:
    def __init__(self, journal):
        self.journal = journal
        self.state = {'http_calls': 0, 'http_errors': 0}
        self.records = []
        self.lock = threading.Lock()

    def add(self, kind, payload):
        if kind != 'http':
            raise ValueError('source_probe_has_no_trading_authority')
        ref = self.journal.add('source_http', payload)
        with self.lock:
            self.records.append(payload)
        if payload['http_status'] in (401, 403):
            raise PermissionError('source_access_denied_' + str(payload['http_status']))
        return ref


def source_check(network, log, wallet, scheduled):
    end, start = int(time.time()), int(scheduled) - 60
    before = time.time()
    try:
        rows, at = frozen.pages(network, 'https://data-api.polymarket.com/v2/trades',
            {'user': wallet, 'taker_only': 'false', 'limit': 1000, 'start': start, 'end': end}, wallet)
        if any(not start <= float(MODEL.number(x['timestamp'])) <= end for x in rows):
            raise ValueError('source_execution_window_filter_violation')
        records = [x for x in log.records if x['sent_at'] >= before and
            urllib.parse.parse_qs(urllib.parse.urlsplit(x['url']).query).get('user') == [wallet]]
        if not records:
            raise ValueError('source_poll_without_saved_response')
        for record in records:
            issues, _ = transport({**record, 'status': record['http_status']}, 20)
            if issues:
                raise ValueError('source_http_not_fresh:' + ','.join(issues))
        return {'usable': True, 'last_successful_source_poll': at, 'returned_executions': len(rows),
            'latest_returned_execution_at': max((float(x['timestamp']) for x in rows), default=None),
            'empty_poll_is_not_a_trade_or_zero_pnl': True}
    except (ValueError, KeyError, TypeError) as exc:
        return {'usable': False, 'issues': [str(exc)]}


def summarize(plan, rows, now):
    planned = plan['duration_seconds'] // INTERVAL
    cycles = {}
    for row in rows:
        if row['kind'] != 'live_gate_cycle':
            continue
        p = row['payload']
        if type(p['tick']) is not int or not 0 <= p['tick'] < planned or p['tick'] in cycles:
            raise ValueError('duplicate_or_invalid_gate_tick')
        cycles[p['tick']] = p
    expected = min(planned, max(0, math.ceil((now - plan['started_at']) / INTERVAL)))
    markets, sources = {}, {}
    for item in plan['watch']['markets']:
        slug = item['market_slug']
        counts, problems = collections.Counter(), collections.Counter()
        matched_times = set()
        for tick in range(expected):
            sample = cycles.get(tick, {}).get('markets', {}).get(slug)
            if not sample:
                problems['missing_scheduled_observation'] += 1
                continue
            b, p = sample['book'], sample['phase']
            quote = bool(b.get('kind') == 'book' and b.get('usable') and b.get('stream', {}).get('usable'))
            counts['fresh_stream_quote_ticks'] += quote
            counts['verified_live_phase_ticks'] += bool(p.get('usable'))
            counts['valid_live_quote_ticks'] += quote and bool(p.get('usable'))
            counts['matched_fresh_pairs'] += bool(b.get('comparison', {}).get('matched'))
            if b.get('comparison', {}).get('matched'):
                matched_times.add(b['comparison'].get('book_at'))
            problems.update(p.get('issues', []))
            problems.update(b.get('issues', []))
            if b.get('kind') != 'book':
                problems['non_tradable_or_settlement_not_live_quote'] += 1
        markets[slug] = {**counts, 'planned_ticks': planned, 'expected_elapsed_ticks': expected,
            'matched_distinct_book_timestamps': len(matched_times - {None}),
            'live_quote_coverage_full_planned': counts['valid_live_quote_ticks'] / planned,
            'fresh_stream_coverage_elapsed': counts['fresh_stream_quote_ticks'] / max(1, expected),
            'problems': dict(problems)}
    for wallet in PROTOCOL['wallets']:
        address = wallet['address']
        good = sum(bool(cycles.get(t, {}).get('sources', {}).get(address, {}).get('usable')) for t in range(expected))
        sources[address] = {'name': wallet['name'], 'valid_source_poll_ticks': good,
            'planned_ticks': planned, 'expected_elapsed_ticks': expected,
            'coverage_full_planned': good / planned, 'coverage_elapsed': good / max(1, expected)}
    complete = now >= plan['started_at'] + plan['duration_seconds']
    preflight = (plan['mode'] == 'preflight' and complete and len(cycles) == planned
        and all(m['fresh_stream_quote_ticks'] >= max(1, planned - 1) for m in markets.values())
        and all(s['coverage_full_planned'] >= .95 for s in sources.values()))
    passed = (plan['mode'] == 'live' and complete and len(markets) == 2
        and all(m['live_quote_coverage_full_planned'] >= .95 and m['matched_distinct_book_timestamps'] >= 3 for m in markets.values())
        and all(s['coverage_full_planned'] >= .95 for s in sources.values()))
    impossible = (plan['mode'] == 'live' and any(expected - x['valid_live_quote_ticks'] > planned * .05
        for x in markets.values())) or (plan['mode'] == 'live' and any(
        expected - s['valid_source_poll_ticks'] > planned * .05 for s in sources.values()))
    return {'schema': 1, 'run_id': plan['run_id'], 'code_sha': plan['code_sha'],
        'mode': plan['mode'], 'started_at': plan['started_at'], 'planned_end': plan['started_at'] + plan['duration_seconds'],
        'evaluated_at': now, 'actual_elapsed_seconds': max(0, now - plan['started_at']),
        'actual_cycles': len(cycles), 'completed_full_window': complete, 'markets': markets, 'sources': sources,
        'live_gate_passed': passed, 'preflight_passed': preflight, 'cannot_reach_95_percent': impossible,
        'settlement_ticks_credited_as_live_quotes': 0, 'paper_entries': 0, 'real_orders': 0,
        'private_account_requests': 0, 'wallet_profitability_evaluated': False,
        'actual_in_play_phase_certified': passed, 'paper_start_authorized_by_this_file': False,
        'stage': 'LIVE_GATE_PASSED' if passed else 'ARMED_WAITING_FOR_LIVE_WINDOW' if preflight
                 else 'LIVE_GATE_FAILED' if complete or impossible else 'OBSERVING_' + plan['mode'].upper()}


def run(args):
    watch = json.loads((ROOT / 'watch.json').read_bytes())
    protocol_hash = hashlib.sha256((REFERENCE / 'protocol.json').read_bytes()).hexdigest()
    if protocol_hash != watch['protocol_sha256']:
        raise ValueError('frozen_wallet_protocol_identity_changed')
    journal = DurableJournal(args.output)
    stop = threading.Event()
    stream, mirror, background = None, None, None
    failure, publication_errors = None, 0
    duration = 120 if args.mode == 'preflight' else DURATION
    plan = {'run_id': args.run_id, 'code_sha': args.code_sha, 'mode': args.mode,
        'duration_seconds': duration, 'interval_seconds': INTERVAL, 'watch': watch,
        'started_at': time.time() + 5, 'source_wallets': PROTOCOL['wallets']}
    try:
        atomic_write(args.output / 'plan.json', canonical(plan) + b'\n', immutable=True)
        journal.add('live_gate_plan', plan)
        mirror = GitMirror(args.run_id, args.code_sha, args.output)
        background = BackgroundMirror(mirror, journal)
        stream = ReconnectingStream([m['market_slug'] for m in watch['markets']], journal, stop)
        stream.start()
        stop.wait(max(0, plan['started_at'] - time.time()))
        client = PublicClient(journal, deadline=plan['started_at'] + duration + 15)
        events = EventClient(journal)
        source_log = SourceLog(journal)
        source_network = frozen.Network(PROTOCOL, source_log)
        next_seal = time.time()
        end = plan['started_at'] + duration
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            tick = 0
            while time.time() < end:
                scheduled = plan['started_at'] + tick * INTERVAL
                stop.wait(max(0, min(scheduled, end) - time.time()))
                if time.time() >= end or tick >= duration // INTERVAL:
                    break
                if stream.fatal:
                    raise PermissionError(stream.fatal)
                futures = {w['address']: pool.submit(source_check, source_network, source_log, w['address'], scheduled)
                    for w in PROTOCOL['wallets']}
                def sample(item):
                    event = phase(events.fresh(item, scheduled), item)
                    book = observe(client, item['market_slug'], item['market_identity'], stream, scheduled)
                    return {'phase': event, 'book': book}
                market_futures = {m['market_slug']: pool.submit(sample, m) for m in watch['markets']}
                cycle = {'tick': tick, 'scheduled_at': scheduled,
                    'sources': {w: f.result() for w, f in futures.items()},
                    'markets': {s: f.result() for s, f in market_futures.items()}}
                journal.add('live_gate_cycle', cycle)
                now = time.time()
                value = summarize(plan, journal.rows, now)
                if now >= next_seal:
                    journal.seal(value)
                    background.submit()
                    print(json.dumps({'checkpoint': journal.checkpoint, 'stage': value['stage'],
                        'actual_cycles': value['actual_cycles'], 'live_gate_passed': value['live_gate_passed']}), flush=True)
                    next_seal = now + 300
                background.poll()
                if value['cannot_reach_95_percent']:
                    raise RuntimeError('live_or_source_coverage_cannot_reach_frozen_95_percent')
                tick = max(tick + 1, math.ceil((time.time() - plan['started_at']) / INTERVAL))
        stop.wait(max(0, end - time.time()))
    except Exception as exc:
        failure = type(exc).__name__ + ':' + str(exc)
        journal.add('gate_failure', {'at': time.time(), 'failure': failure})
    finally:
        if stream:
            stream.close()
        now = time.time()
        value = summarize(plan, journal.rows, now)
        value.update(failure=failure)
        if failure:
            value['live_gate_passed'] = False
            value['preflight_passed'] = False
            value['stage'] = 'FAILED_NO_PAPER_START'
        journal.seal(value)
        if background:
            background.close()
            publication_errors = background.errors
            journal.add('capture_completed', {'at': time.time(), 'publication_errors': publication_errors,
                'mode': args.mode, 'failure': failure})
            value['publication_errors'] = publication_errors
            journal.seal(value)
            mirror.sync(journal)
        verify_extra_http(journal.rows)
        checked = verify_checkpoints(args.output)
        if checked['rows'] != journal.rows:
            raise ValueError('sealed_checkpoint_does_not_equal_journal')
        journal.close()
    # Independently restore the exact remotely published generation. A green job alone is insufficient.
    restored_path = args.output.parent / (args.output.name + '-round-trip')
    restored_path.mkdir(exist_ok=False)
    restore = GitMirror(args.run_id, args.code_sha, restored_path)
    if not restore.restore():
        raise ValueError('no_completed_remote_checkpoint')
    remote = DurableJournal(restored_path, resume=True)
    try:
        verify_extra_http(remote.rows)
        if remote.rows != checked['rows']:
            raise ValueError('published_generation_behind_or_different')
        remote_value = json.loads((restored_path / 'summary.json').read_bytes())
        if remote_value != value:
            raise ValueError('published_summary_mismatch')
    finally:
        remote.close()
    result = {'run_id': args.run_id, 'code_sha': args.code_sha,
        'published_state_commit': restore.head, 'checkpoints': checked['checkpoints'],
        'raw_records': checked['seq'], 'raw_final_hash': checked['head'],
        'published_round_trip_verified': True, 'publication_errors': publication_errors,
        'stage': value['stage'], 'preflight_passed': value['preflight_passed'],
        'live_gate_passed': value['live_gate_passed'], 'failure': failure,
        'paper_entries': 0, 'real_orders': 0}
    atomic_write(args.output / 'verification.json', canonical(result) + b'\n')
    print('LIVE_GATE_VERIFICATION=' + json.dumps(result, sort_keys=True), flush=True)
    if failure or not (value['live_gate_passed'] if args.mode == 'live' else value['preflight_passed']):
        raise RuntimeError('gate_not_passed_no_paper_start')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--code-sha', required=True)
    parser.add_argument('--mode', choices=('preflight', 'live'), required=True)
    parser.add_argument('--approved-readonly-check', action='store_true', required=True)
    run(parser.parse_args())
