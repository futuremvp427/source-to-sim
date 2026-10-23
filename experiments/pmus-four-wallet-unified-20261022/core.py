"""Integrated paper study. Frozen strategy imports, no venue order authority."""
from __future__ import annotations
import base64
import collections
import concurrent.futures
import copy
import hashlib
import json
import lzma
import math
import re
import sys
import threading
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REFERENCE = ROOT.parent / 'pmus-four-wallet-20261018'
REPAIR = ROOT.parent / 'pmus-data-reliability-20261018'
sys.path.insert(0, str(REFERENCE))
import collector as frozen
sys.path.insert(0, str(REPAIR))
from durable import DurableJournal, atomic_write, decode_rows, verify_checkpoints
from quality import MODEL, canonical, digest, transport
from stream_smoke import (StreamState, auth_headers, connect_market_stream,
                          read_stream, safe_error)


def protocol():
    return json.loads((ROOT / 'protocol.json').read_bytes())


def source_market_document(network, condition):
    # Exact-identifier metadata lookup must include both open and closed records.
    # This does not authorize entries from old holdings or foreign settlement.
    body, at = network.get(frozen.query('https://gamma-api.polymarket.com/markets',
                                      {'condition_ids': condition, 'closed': 'any'}))
    if not isinstance(body, list) or len(body) != 1 or body[0].get('conditionId') != condition:
        raise ValueError('source_market_identity')
    return body[0], at


def delta(old, new):
    """Small deterministic state patches avoid persisting the full ledger per tick."""
    if old == new:
        return None
    if isinstance(old, dict) and isinstance(new, dict):
        changed = {k: delta(old[k], v) if k in old else {'replace': v}
                   for k, v in new.items() if k not in old or old[k] != v}
        return {'keys': changed, 'delete': sorted(set(old) - set(new))}
    if isinstance(old, list) and isinstance(new, list) and new[:len(old)] == old:
        return {'append': new[len(old):]}
    return {'replace': new}


def patched(old, patch):
    if patch is None:
        return copy.deepcopy(old)
    if 'replace' in patch:
        return copy.deepcopy(patch['replace'])
    if 'append' in patch:
        if not isinstance(old, list):
            raise ValueError('invalid_append_patch')
        return copy.deepcopy(old + patch['append'])
    if not isinstance(old, dict):
        raise ValueError('invalid_object_patch')
    out = copy.deepcopy(old)
    for key in patch['delete']:
        del out[key]
    for key, value in patch['keys'].items():
        out[key] = patched(out.get(key), value)
    return out


class PaperJournal(DurableJournal):
    """Reuse repaired fsync/seal/recovery; only selected books are fully captured."""
    def __init__(self, root, resume=False):
        root = Path(root)
        recovered_tail = None
        if resume and (root / 'events.jsonl').is_file():
            data = (root / 'events.jsonl').read_bytes()
            if data and not data.endswith(b'\n'):
                offset = data.rfind(b'\n') + 1
                prefix, tail = data[:offset], data[offset:]
                decode_rows(prefix)  # A corrupt complete row is never discarded.
                name = 'unacknowledged-tail-' + hashlib.sha256(tail).hexdigest() + '.bin'
                atomic_write(root / name, tail, immutable=True)
                atomic_write(root / 'events.jsonl', prefix)
                recovered_tail = {'preserved_tail_file': name, 'bytes': len(tail),
                    'reason': 'add() acknowledges only a complete newline plus fsync; no acknowledged row removed'}
        super().__init__(root, resume=resume, evidence_limit=protocol()['maximum_wal_bytes'],
                         body_limit=protocol()['maximum_compressed_evidence_bytes'])
        if recovered_tail:
            self.add('unacknowledged_partial_tail_preserved', recovered_tail)

    def add(self, kind, payload):
        # A later account mutation must never alter an already hashed WAL row.
        return super().add(kind, copy.deepcopy(payload))

    def store_http(self, record):
        raw = base64.b64decode(record['raw_base64'], validate=True)
        if len(raw) != record['body_bytes'] or hashlib.sha256(raw).hexdigest() != record['body_sha256']:
            raise ValueError('paper_http_digest_mismatch')
        key = record['body_sha256']
        with self.lock:
            name = 'bodies/' + key + '.xz'
            if not (self.root / name).exists():
                compressed = lzma.compress(raw, preset=3)
                if self.body_total + len(compressed) > self.body_limit:
                    raise RuntimeError('compressed_body_evidence_limit_reached')
                atomic_write(self.root / name, compressed, immutable=True)
                self.body_total += len(compressed)
            compressed = (self.root / name).read_bytes()
            return self.add('paper_http', {k: v for k, v in record.items() if k != 'raw_base64'} |
                            {'body_path': name, 'compressed_bytes': len(compressed),
                             'compressed_sha256': hashlib.sha256(compressed).hexdigest()})


class StreamReceiptBuffer:
    """Keep unused updates only in memory; persist exact selected receipt before fill."""
    def __init__(self, journal):
        self.journal = journal

    def stream_receipt(self, md, at):
        return {'buffered_receipt': True, 'received_at': at, 'sha256': digest(md)}

    def add(self, kind, payload):
        return self.journal.add(kind, payload)

    def capture_stream_book(self, md, at, ref):
        if ref != {'buffered_receipt': True, 'received_at': at, 'sha256': digest(md)}:
            raise ValueError('buffered_stream_receipt_changed')
        receipt = self.journal.stream_receipt(md, at)
        return self.journal.capture_stream_book(md, at, receipt)


class DynamicStream:
    """One market-data socket; additions do not invalidate books of existing holdings."""
    def __init__(self, journal):
        self.journal, self.stop = journal, threading.Event()
        self.state = StreamState([], StreamReceiptBuffer(journal))
        self.desired, self.sent = set(), set()
        self.lock = threading.RLock()
        self.fatal, self.connection = None, None
        self.worker = threading.Thread(target=self.run, daemon=True)

    def ensure(self, slug):
        if not re.fullmatch(r'aec-[a-z0-9-]{1,180}', slug):
            raise ValueError('invalid_market_slug')
        with self.lock, self.state.lock:
            if slug not in self.desired and len(self.desired) >= protocol()['maximum_stream_markets']:
                raise ValueError('stream_subscription_capacity')
            self.desired.add(slug)
            self.state.slugs = list(self.desired)
            self.state.history.setdefault(slug, collections.deque(maxlen=128))

    def retain(self, slugs):
        with self.lock:
            # Retired subscriptions are removed by reconnect, without clearing current holdings.
            self.desired.intersection_update(slugs)

    def start(self):
        auth_headers(__import__('os').environ.get('PMUS_DATA_KEY_ID', ''),
                     __import__('os').environ.get('PMUS_DATA_SECRET_KEY', ''))
        self.worker.start()

    def run(self):
        import os
        failures = 0
        while not self.stop.is_set():
            receiver, conn, local_stop = None, None, threading.Event()
            try:
                headers = auth_headers(os.environ.get('PMUS_DATA_KEY_ID', ''),
                                       os.environ.get('PMUS_DATA_SECRET_KEY', ''))
                conn = connect_market_stream(headers)
                self.connection = conn
                with self.state.lock:
                    self.state.latest.clear()
                    for history in self.state.history.values():
                        history.clear()
                    self.state.last_transport_at = None
                    self.state.failure, self.state.connected = None, True
                self.sent = set()
                self.journal.add('stream_connected', {'at': time.time(), 'scope': 'markets_only'})
                receiver = threading.Thread(target=read_stream, args=(conn, self.state, local_stop), daemon=True)
                receiver.start()
                connected_at = time.time()
                while not self.stop.wait(.25) and not self.state.failure:
                    with self.lock:
                        wanted = set(self.desired)
                    for slug in sorted(wanted - self.sent):
                        conn.send(json.dumps({'subscribe': {'request_id': digest(slug)[:24],
                            'subscription_type': 1, 'market_slugs': [slug]}}))
                        self.sent.add(slug)
                    for slug in sorted(self.sent - wanted):
                        conn.send(json.dumps({'unsubscribe': {'request_id': digest(slug)[:24]}}))
                        self.sent.remove(slug)
                    if time.time() - (self.state.last_transport_at or connected_at) > 30:
                        raise TimeoutError('stream_transport_timeout')
                reason = self.state.failure or 'bounded_shutdown'
                if time.time() - connected_at > 60:
                    failures = 0
            except Exception as error:
                reason = ('stream_transport_timeout' if isinstance(error, TimeoutError)
                          and str(error) == 'stream_transport_timeout' else safe_error(error))
            finally:
                with self.state.lock:
                    self.state.connected = False
                local_stop.set()
                if conn:
                    try:
                        conn.close(timeout=1)
                    except Exception:
                        pass
                if receiver:
                    receiver.join(timeout=3)
                    if receiver.is_alive():
                        self.fatal = 'stream_reader_shutdown_failed'
            self.journal.add('stream_disconnected', {'at': time.time(), 'reason': reason})
            if reason.startswith('authentication_denied') or reason in ('redirect_refused', 'subscription_error'):
                self.fatal = reason
            if self.fatal:
                return
            failures += 1
            self.stop.wait(min(2 ** min(failures, 5), 30))

    def close(self):
        self.stop.set()
        if self.worker.ident:
            self.worker.join(timeout=15)
            if self.worker.is_alive():
                raise RuntimeError('stream_supervisor_shutdown_failed')


class CollectorLog:
    def __init__(self, journal, state):
        self.journal, self.state = journal, state
        self.local, self.buffer = threading.local(), []

    def add(self, kind, payload):
        if kind == 'http':
            ref = self.journal.store_http(payload)
            self.local.last_http = {**payload, 'evidence': ref}
            if hasattr(self.local, 'poll_records'):
                self.local.poll_records.append(self.local.last_http)
            return ref
        if kind in ('paper_fill', 'us_settlement', 'mapping'):
            self.buffer.append({'kind': kind, 'payload': copy.deepcopy(payload)})
            return None
        return self.journal.add(kind, payload)


class StrictNetwork(frozen.Network):
    def get(self, url):
        try:
            value = super().get(url)
        except ValueError:
            record = getattr(self.journal.local, 'last_http', {})
            if record.get('http_status') in (401, 403):
                raise PermissionError('public_source_or_market_access_denied') from None
            raise
        record = self.journal.local.last_http
        metadata = urllib.parse.urlsplit(url).netloc == 'gamma-api.polymarket.com' or '/market/slug/' in url
        issues, _ = transport({**record, 'status': record['http_status']}, 300 if metadata else 20)
        if issues:
            raise ValueError('unqualified_http:' + ','.join(issues))
        return value


def initial_state(p, code_sha, now):
    state = {'study_id': p['study_id'], 'code_sha': code_sha,
        'protocol_sha256': hashlib.sha256((ROOT / 'protocol.json').read_bytes()).hexdigest(),
        'started_at': now, 'entry_end': now + 3600 * p['entry_collection_hours'],
        'hard_stop': now + 3600 * (p['entry_collection_hours'] + p['maximum_settlement_drain_hours']),
        'last_cycle_at': now, 'checkpoint_number': 0, 'segment': 0, 'segment_complete': False,
        'terminal': False, 'fatal_error': None, 'entries_stopped_reason': None,
        'raw_hash': '0' * 64, 'raw_seq': 0, 'http_calls': 0, 'http_errors': 0,
        'cycles': 0, 'last_tick': -1, 'mappings': {}, 'accounts': {}, 'health': {}}
    for wallet in p['wallets']:
        a = MODEL.new_account(wallet['name'], wallet['address'], p['starting_capital_usd'])
        a.update(last_feed_end=int(now), held_mark_planned_ticks=0, held_mark_complete_ticks=0,
                 scheduled_complete_mark_ticks=0, source_valid_ticks=0, source_missed_ticks=0)
        state['accounts'][wallet['address']] = a
    return state


class IntegratedCollector(frozen.Collector):
    def __init__(self, state, p, journal, stream):
        self.s, self.p, self.work = state, p, journal.root
        self.evidence, self.stream = journal, stream
        self.journal = CollectorLog(journal, state)
        self.net = StrictNetwork(p, self.journal)
        self.source_cache, self.us_cache, self.book_cache, self.quote_refs = {}, {}, {}, {}
        self.us_evidence = {}
        self.committed = copy.deepcopy(state)

    def source_market(self, condition, fresh=False):
        cached = self.source_cache.get(condition)
        if not fresh and cached and time.time() - cached[1] < self.p['metadata_cache_seconds']:
            return cached[0]
        body, at = source_market_document(self.net, condition)
        self.source_cache[condition] = (body, at)
        return body

    def verified_feed(self, account):
        self.journal.local.poll_records = []
        rows, at, end = frozen.read_feed(self.net, account, self.s)
        records = self.journal.local.poll_records
        for row in rows:
            matches = [r['evidence'] for r in records
                if row in json.loads(base64.b64decode(r['raw_base64'])).get('data', [])]
            if not matches:
                raise ValueError('source_execution_without_saved_response')
            row['_source_http_evidence'] = matches[-1]
        return rows, at, end

    def current_book(self, slug):
        self.stream.ensure(slug)
        now = time.time()
        result = self.stream.state.snapshot(slug, now)
        if not result.get('usable'):
            raise ValueError('no_current_qualified_stream_book')
        ref = result['evidence']
        row = self.evidence.rows[ref['seq'] - 1]
        if row['hash'] != ref['hash'] or row['kind'] != 'stream_book':
            raise ValueError('stream_quote_reference_mismatch')
        payload = row['payload']
        if payload['received_at'] > now:
            raise ValueError('future_stream_receipt')
        snapshot = MODEL.book({'marketData': payload['market_data']}, slug, now, self.p['maximum_book_age_seconds'])
        self.quote_refs[slug] = ref
        return snapshot

    def trade(self, account, condition, mapping, side, action, q, signal=None):
        if action == 'BUY' and self.s.get('entries_stopped_reason'):
            raise ValueError('new_entries_stopped_preserving_inventory')
        if action == 'BUY' and signal:
            # A pending SELL (or a BUY on the other token) cannot start the
            # observation delay for this executed BUY. Bind it to this BUY's
            # original durable HTTP receipt, without resetting that receipt on
            # repeated source polls or weakening the frozen delay.
            now = time.time()
            buys = [r for r in signal['rows'] if r['side'] == 'BUY'
                    and r['token_id'] == mapping['sides'][side]['token']
                    and 0 <= now - float(r['timestamp']) <= self.p['maximum_signal_age_seconds']]
            if buys:
                reference = max(buys, key=lambda r: r['timestamp'])
                ref = reference['_source_http_evidence']
                seq = ref.get('seq')
                if type(seq) is not int or not 1 <= seq <= len(self.evidence.rows):
                    raise ValueError('source_buy_observation_reference_mismatch')
                raw = self.evidence.rows[seq - 1]
                if raw['hash'] != ref['hash'] or raw['kind'] != 'paper_http':
                    raise ValueError('source_buy_observation_reference_mismatch')
                observed_at = float(raw['payload']['received_at'])
                if observed_at > now:
                    raise ValueError('future_source_buy_observation')
                signal = {**signal, 'first_seen': max(float(signal['first_seen']), observed_at)}
        # Refresh identity/rules/fee metadata before every actual modeled transaction.
        target = self.us_market(mapping['us_slug'], fresh=True)
        verify_target_identity(mapping, target)
        before, buffered = copy.deepcopy(account), len(self.journal.buffer)
        made = super().trade(account, condition, mapping, side, action, q, signal)
        if made:
            row = account['ledger'][-1]
            ref = self.quote_refs[mapping['us_slug']]
            quote = self.evidence.rows[ref['seq'] - 1]['payload']['market_data']
            try:
                # Metadata/source refreshes must not let a formerly fresh quote age out before commit.
                MODEL.book({'marketData': quote}, mapping['us_slug'], time.time(), self.p['maximum_book_age_seconds'])
                if action == 'BUY' and time.time() - float(row['source_trade_at']) > self.p['maximum_signal_age_seconds']:
                    raise ValueError('source_expired_before_fill_commit')
            except ValueError:
                account.clear()
                account.update(before)
                account['quote_attempts'] += 1
                account['quote_failures'] += 1
                del self.journal.buffer[buffered:]
                raise
            row['quote_evidence'] = copy.deepcopy(self.quote_refs[mapping['us_slug']])
            if signal and action == 'BUY':
                row['source_signal_rows_sha256'] = digest(signal['rows'])
                buys = [r for r in signal['rows'] if r['side'] == 'BUY'
                        and r['token_id'] == mapping['sides'][side]['token']
                        and r['timestamp'] == row['source_trade_at']]
                # Match frozen.trade()'s stable first maximum, including when
                # several different executions share the same timestamp.
                reference = buys[0]
                row['source_execution'] = {k: v for k, v in reference.items() if k != '_source_http_evidence'}
                row['source_execution_evidence'] = reference['_source_http_evidence']
            self.journal.buffer[-1]['payload'] = {'wallet': account['wallet'], **copy.deepcopy(row)}
        return made

    def settle_us_first(self, account):
        for condition, pos in account['positions'].items():
            if MODEL.number(pos['quantity']) <= 0:
                continue
            mapping = self.s['mappings'][condition]
            try:
                target = self.us_market(mapping['us_slug'])
                if target.get('status') != 'MARKET_STATUS_RESOLVED' or target.get('closed') is not True:
                    continue
                verify_target_identity(mapping, target)
                metadata_reference = self.us_evidence[mapping['us_slug']]
                value, at = self.net.get('https://gateway.polymarket.us/v1/markets/' + mapping['us_slug'] + '/settlement')
                settlement_reference = self.journal.local.last_http['evidence']
                price = MODEL.number(value.get('settlement'))
                long = [s for s in target['marketSides'] if s['long'] is True]
                if (value.get('slug') != mapping['us_slug'] or not 0 <= price <= 1
                        or len(long) != 1 or MODEL.number(long[0]['price']) != price):
                    raise ValueError('unverified_us_settlement')
                row = MODEL.settle(account, condition, mapping, price, at)
                row.update(metadata_evidence=metadata_reference, settlement_evidence=settlement_reference)
                pos['settled'] = True
                self.journal.add('us_settlement', {'wallet': account['wallet'], **row})
            except ValueError as error:
                frozen.skip(account, 'us_settlement_wait:' + str(error))

    def service_account(self, account):
        self.settle_us_first(account)
        if not self.s.get('source_access_denied'):
            super().service_account(account)

    def us_market(self, slug, fresh=False):
        cached = self.us_cache.get(slug)
        if not fresh and cached and time.time() - cached[1] < self.p['metadata_cache_seconds']:
            return cached[0]
        value = super().us_market(slug, fresh=fresh)
        self.us_evidence[slug] = self.journal.local.last_http['evidence']
        return value

    def mark(self, account):
        before = account['complete_mark_checks']
        super().mark(account)
        # original mark() increments exactly once; only a complete valuation earns a tick.
        complete = account['complete_mark_checks'] == before + 1
        if not complete:
            frozen.skip(account, 'incomplete_current_liquidation_mark')
        account['scheduled_complete_mark_ticks'] += bool(complete)
        held = any(MODEL.number(p['quantity']) > 0 for p in account['positions'].values())
        was_held = self.held_before.get(account['wallet'], False)
        if held or was_held:
            account['held_mark_planned_ticks'] += (self.tick_gap if was_held else 0) + 1
            account['held_mark_complete_ticks'] += bool(complete)

    def cycle(self, tick):
        if type(tick) is not int or tick <= self.s['last_tick']:
            raise ValueError('duplicate_or_rewound_paper_tick')
        self.cycle_started_at = time.time()
        self.tick_gap = tick - self.s['last_tick'] - 1
        self.book_cache = {}
        self.s['last_cycle_at'] = self.cycle_started_at
        accounts = list(self.s['accounts'].values())
        self.held_before = {a['wallet']: any(MODEL.number(p['quantity']) > 0 for p in a['positions'].values()) for a in accounts}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            feeds = {a['wallet']: pool.submit(self.verified_feed, a) for a in accounts if not self.s.get('source_access_denied')}
            for account in accounts:
                if account['wallet'] not in feeds:
                    continue
                try:
                    self.observe_feed(account, *feeds[account['wallet']].result())
                    account['source_valid_ticks'] += self.cycle_started_at < self.s['entry_end']
                except PermissionError:
                    raise
                except ValueError as error:
                    account['source_poll_failures'] += 1
                    frozen.skip(account, 'source_feed_error:' + str(error))
        for account in accounts:
            account['source_missed_ticks'] += self.tick_gap
            self.service_account(account)
            self.mark(account)
            MODEL.verify_account(account, self.p['starting_capital_usd'])
        self.s['cycles'] += 1
        self.s['last_tick'] = tick
        self.s['last_cycle_at'] = time.time()
        if self.s['last_cycle_at'] >= self.s['hard_stop'] or (self.s['last_cycle_at'] >= self.s['entry_end']
                and not any(MODEL.number(p['quantity']) > 0 for a in self.s['accounts'].values() for p in a['positions'].values())):
            self.s['terminal'] = True
        self.commit()
        wanted = {self.s['mappings'][c]['us_slug'] for a in self.s['accounts'].values()
                  for c in set(a['pending']) | {c for c, p in a['positions'].items() if MODEL.number(p['quantity']) > 0}
                  if c in self.s['mappings']}
        self.stream.retain(wanted)

    def commit(self):
        payload = {'before_sha256': digest(self.committed), 'after_sha256': digest(self.s),
            'patch': delta(self.committed, self.s), 'events': copy.deepcopy(self.journal.buffer)}
        self.evidence.add('paper_commit', payload)
        self.committed = copy.deepcopy(self.s)
        self.journal.buffer.clear()

    def rollback_incomplete_cycle(self):
        self.s = copy.deepcopy(self.committed)
        self.journal.state = self.s
        self.journal.buffer.clear()


def verify_target_identity(mapping, target):
    actual = {str(s['id']): s for s in target['marketSides']}
    if (target['slug'] != mapping['us_slug'] or MODEL.stamp(target['gameStartTime']) != mapping['start_at']
            or MODEL.sha(target['description'].encode()) != mapping['us_rules_sha256']
            or set(actual) != {str(s['us_side_id']) for s in mapping['sides']}):
        raise ValueError('changed_us_contract_identity')
    for side in mapping['sides']:
        value = actual[str(side['us_side_id'])]
        if value['long'] is not side['long'] or value['description'] != side['us_outcome']:
            raise ValueError('changed_us_side_orientation')


def replay(rows, p):
    state = None
    raw_ledger = collections.defaultdict(list)
    for raw in rows:
        if raw['kind'] == 'paper_initial_state':
            if state is not None:
                raise ValueError('duplicate_initial_paper_state')
            state = copy.deepcopy(raw['payload'])
        if raw['kind'] != 'paper_commit':
            continue
        change = raw['payload']
        if state is None or digest(state) != change['before_sha256']:
            raise ValueError('paper_state_patch_predecessor_mismatch')
        state = patched(state, change['patch'])
        if digest(state) != change['after_sha256']:
            raise ValueError('paper_state_patch_hash_mismatch')
        for event in change['events']:
            if event['kind'] in ('paper_fill', 'us_settlement'):
                value = dict(event['payload'])
                wallet = value.pop('wallet')
                raw_ledger[wallet].append(value)
        for wallet, account in state['accounts'].items():
            MODEL.verify_account(account, p['starting_capital_usd'])
            if account['ledger'] != raw_ledger[wallet]:
                raise ValueError('raw_fill_or_us_settlement_ledger_mismatch')
    if state is None:
        raise ValueError('no_paper_initial_state')
    return state


def evaluation(state, p, now=None):
    now = state['last_cycle_at'] if now is None else now
    expected = min(math.ceil((state['hard_stop'] - state['started_at']) / p['poll_seconds']),
                   max(0, math.ceil((now - state['started_at']) / p['poll_seconds'])))
    accounts = []
    for wallet in p['wallets']:
        a = state['accounts'][wallet['address']]
        metrics = MODEL.metrics(a, state['mappings'], p, now, state['started_at'], state['entry_end'], state['terminal'])
        complete_cov = a['scheduled_complete_mark_ticks'] / max(1, expected)
        held_cov = a['held_mark_complete_ticks'] / a['held_mark_planned_ticks'] if a['held_mark_planned_ticks'] else None
        metrics.update(scheduled_complete_mark_coverage=complete_cov, held_inventory_mark_coverage=held_cov,
            scheduled_mark_expected_ticks=expected, scheduled_complete_mark_ticks=a['scheduled_complete_mark_ticks'],
            held_mark_planned_ticks=a['held_mark_planned_ticks'], held_mark_complete_ticks=a['held_mark_complete_ticks'],
            remaining_distinct_markets_required=max(0, p['minimum_completed_distinct_markets'] - metrics['completed_distinct_markets']),
            total_account_profit_including_unresolved=None if metrics['open_distinct_markets'] else metrics['completed_net_after_modeled_fees_usd'],
            open_positions=[{'condition': c, 'us_slug': state['mappings'][c]['us_slug'],
                'scheduled_start_at': state['mappings'][c]['start_at'], 'quantity': pos['quantity'], 'side': pos['side']}
                for c, pos in a['positions'].items() if MODEL.number(pos['quantity']) > 0])
        if not a['games']:
            metrics['completed_net_after_modeled_fees_usd'] = None
            metrics['completed_stress_net_usd'] = None
            metrics['total_account_profit_including_unresolved'] = None
        if (state['terminal'] and not metrics['open_distinct_markets'] and
                (complete_cov < .95 or (held_cov is not None and held_cov < .95))):
            metrics['status'] = 'INSUFFICIENT_TRADES/COVERAGE'
        latencies = [float(row['source_to_paper_seconds']) for row in a['ledger'] if 'source_to_paper_seconds' in row]
        metrics['source_to_fill_latency_seconds'] = {'count': len(latencies),
            'minimum': min(latencies, default=None), 'maximum': max(latencies, default=None),
            'mean': sum(latencies) / len(latencies) if latencies else None}
        accounts.append(metrics)
    return {'schema': 1, 'study_id': state['study_id'], 'code_sha': state['code_sha'],
        'protocol_sha256': state['protocol_sha256'], 'started_at': state['started_at'],
        'entry_end': state['entry_end'], 'hard_stop': state['hard_stop'], 'measured_through': now,
        'cycles': state['cycles'], 'terminal': state['terminal'], 'entries_stopped_reason': state.get('entries_stopped_reason'),
        'accounts': accounts, 'real_orders': 0, 'private_account_requests': 0,
        'accounts_are_not_a_combined_portfolio': True, 'durable_profitability_proven': False}


def render_report(value, run_id):
    from datetime import datetime, timezone
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat()
    money = lambda x: 'N/A' if x is None else '$' + format(MODEL.number(x), '.2f')
    pct = lambda x: 'N/A (no held exposure)' if x is None else format(x, '.2%')
    lines = ['# Integrated four-wallet paper study', '',
        'Stage: ' + ('TERMINAL' if value['terminal'] else 'PARTIAL / NOT FINAL'),
        'Exact run: https://github.com/futuremvp427/source-to-sim/actions/runs/' + str(run_id),
        'Code: `' + value['code_sha'] + '`; protocol SHA-256: `' + value['protocol_sha256'] + '`.',
        'Actual measured interval: ' + iso(value['started_at']) + ' to ' + iso(value['measured_through']) + '.',
        'Planned entries end ' + iso(value['entry_end']) + '; bounded drain ends ' + iso(value['hard_stop']) + '.', '',
        'Four independent fictional $1,000 accounts; no combined realizable portfolio. Source profits are not follower returns.', '',
        '| Wallet | Completed net after modeled fees | Stress net | Completed distinct US markets | Open markets | Screen |',
        '| --- | ---: | ---: | ---: | ---: | --- |']
    for a in value['accounts']:
        lines.append('| ' + ' | '.join([a['name'], money(a['completed_net_after_modeled_fees_usd']),
            money(a['completed_stress_net_usd']), str(a['completed_distinct_markets']), str(a['open_distinct_markets']), a['status']]) + ' |')
    lines += ['', 'Completed net excludes unresolved exposure; N/A is not zero P&L. No durable or live-money profitability is established.']
    for a in value['accounts']:
        lines += ['', '## ' + a['name'], '',
            'Actual simulated contracts bought / sold / settled: ' + ' / '.join(a[k] for k in
                ('simulated_contracts_bought', 'simulated_contracts_sold', 'simulated_contracts_settled')) + '.',
            'Observed drawdown: ' + money(a['max_observed_drawdown_usd']) + '; complete scheduled marks: ' + pct(a['scheduled_complete_mark_coverage'])
                + '; held-inventory marks: ' + pct(a['held_inventory_mark_coverage']) + '. Missing marks cannot establish the true maximum drawdown.',
            'Source coverage elapsed / full planned collection: ' + pct(a['source_poll_coverage_of_elapsed_collection']) + ' / '
                + pct(a['source_poll_coverage_of_planned_collection']) + '.',
            'Source-to-fill latency seconds: `' + json.dumps(a['source_to_fill_latency_seconds'], sort_keys=True) + '`.',
            'Fill/skip reasons: `' + json.dumps(a['skips_by_reason'], sort_keys=True) + '`.',
            'Event-cluster bootstrap lower 2.5% stress-mean percentile: ' + str(a['event_cluster_bootstrap_stress_mean_lower_2_5pct']) + '.',
            'Unresolved positions and scheduled dates: `' + json.dumps(a['open_positions'], sort_keys=True) + '`.']
    lines += ['', 'Short screen only: same-game/day dependence, recent-winner selection and four simultaneous comparisons remain limitations. '
              'A positive sample is not proof of a lasting edge; fewer than 30 markets or inadequate coverage remains insufficient.']
    return '\n'.join(lines) + '\n'
