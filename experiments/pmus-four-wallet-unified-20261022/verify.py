"""Offline published-checkpoint, causal-fill and accounting re-evaluation."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import lzma
from pathlib import Path

from core import (MODEL, canonical, evaluation, frozen, protocol, replay,
                  verify_checkpoints, verify_target_identity, render_report)


def verify(root):
    root = Path(root)
    checked = verify_checkpoints(root)
    if not checked['checkpoints']:
        raise ValueError('no_completed_published_paper_checkpoint')
    rows, p = checked['rows'], protocol()
    plan = json.loads((root / 'plan.json').read_bytes())
    expected_protocol = hashlib.sha256((Path(__file__).parent / 'protocol.json').read_bytes()).hexdigest()
    if plan['protocol_sha256'] != expected_protocol:
        raise ValueError('paper_protocol_identity_mismatch')
    bodies = {}

    def reference(ref, kind):
        seq = ref.get('seq')
        if type(seq) is not int or not 1 <= seq <= len(rows):
            raise ValueError('invalid_paper_evidence_reference')
        row = rows[seq - 1]
        if row['hash'] != ref.get('hash') or row['kind'] != kind:
            raise ValueError('paper_evidence_reference_mismatch')
        return row['payload']

    def http(ref):
        record = reference(ref, 'paper_http')
        if (record['method'] != 'GET' or record['authenticated'] is not False
                or not frozen.allowed(record['url'])):
            raise ValueError('unapproved_paper_http_authority')
        if record['body_sha256'] not in bodies:
            name = 'bodies/' + record['body_sha256'] + '.xz'
            if record['body_path'] != name:
                raise ValueError('invalid_body_path')
            compressed = (root / name).read_bytes()
            if (len(compressed) != record['compressed_bytes']
                    or hashlib.sha256(compressed).hexdigest() != record['compressed_sha256']):
                raise ValueError('compressed_paper_http_digest_mismatch')
            raw = lzma.decompress(compressed)
            if len(raw) != record['body_bytes'] or hashlib.sha256(raw).hexdigest() != record['body_sha256']:
                raise ValueError('paper_http_body_digest_mismatch')
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError):
                value = None
            bodies[record['body_sha256']] = value
        return record, bodies[record['body_sha256']]

    for row in rows:
        if row['kind'] == 'paper_http':
            http({'seq': row['seq'], 'hash': row['hash']})
    state = replay(rows, p)
    if (state['code_sha'] != plan['code_sha'] or state['study_id'] != p['study_id']
            or state['protocol_sha256'] != plan['protocol_sha256']
            or {(a['name'], a['wallet']) for a in state['accounts'].values()} !=
                {(w['name'], w['address']) for w in p['wallets']}):
        raise ValueError('paper_code_protocol_wallet_identity_mismatch')
    fresh_accounts = {w['address']: MODEL.new_account(w['name'], w['address'], p['starting_capital_usd']) for w in p['wallets']}
    fills = settlements = 0
    for raw in rows:
        if raw['kind'] != 'paper_commit':
            continue
        for event in raw['payload']['events']:
            if event['kind'] not in ('paper_fill', 'us_settlement'):
                continue
            value = event['payload']
            a = fresh_accounts[value['wallet']]
            mapping = state['mappings'][value['condition']]
            if event['kind'] == 'paper_fill':
                quote = reference(value['quote_evidence'], 'stream_book')
                receipt = reference(quote['receipt_evidence'], 'stream_book_receipt')
                md = quote['market_data']
                if (receipt['book_sha256'] != hashlib.sha256(canonical(md)).hexdigest()
                        or receipt['received_at'] != quote['received_at']
                        or quote['received_at'] > value['at']
                        or value['quote_evidence']['seq'] >= raw['seq']):
                    raise ValueError('noncausal_or_changed_fill_book')
                book = MODEL.book({'marketData': md}, mapping['us_slug'], value['at'], p['maximum_book_age_seconds'])
                computed = MODEL.execute(book, mapping['sides'][value['side']]['long'], value['action'],
                                         value['quantity'], mapping['fee_coefficient'])
                if any(value[k] != v for k, v in computed.items()):
                    raise ValueError('captured_book_execution_replay_mismatch')
                if value['action'] == 'BUY':
                    source_record, source = http(value['source_execution_evidence'])
                    execution = value['source_execution']
                    if (execution not in source['data'] or execution['proxy_wallet'].lower() != value['wallet']
                            or execution['side'] != 'BUY' or execution['token_id'] != mapping['sides'][value['side']]['token']
                            or source_record['received_at'] > value['signal_first_seen_at']
                            or not state['started_at'] < float(execution['timestamp']) <= value['at']
                            or not 0 <= value['at'] - float(execution['timestamp']) <= p['maximum_signal_age_seconds']
                            or value['at'] - value['signal_first_seen_at'] < p['minimum_observation_delay_seconds']
                            or MODEL.number(value['average_price']) > MODEL.number(execution['price']) + MODEL.number(p['maximum_worse_entry_price'])):
                        raise ValueError('source_signal_causal_entry_replay_mismatch')
                MODEL.apply_fill(a, value['condition'], mapping, value['side'], value['action'], computed,
                                 value['at'], p['stress_cost_per_contract_per_trade'])
                fills += 1
            else:
                meta_record, body = http(value['metadata_evidence'])
                settlement_record, settlement = http(value['settlement_evidence'])
                meta = body['market']
                verify_target_identity(mapping, meta)
                long = next(s for s in meta['marketSides'] if s['long'])
                long_price = MODEL.number(settlement['settlement'])
                if (meta['status'] != 'MARKET_STATUS_RESOLVED' or meta['closed'] is not True
                        or settlement['slug'] != mapping['us_slug'] or MODEL.number(long['price']) != long_price
                        or max(meta_record['received_at'], settlement_record['received_at']) > value['at']):
                    raise ValueError('unverified_us_settlement_replay')
                computed = MODEL.settle(a, value['condition'], mapping, long_price, value['at'])
                if any(computed[k] != value[k] for k in computed):
                    raise ValueError('us_settlement_ledger_replay_mismatch')
                settlements += 1
    for wallet, a in fresh_accounts.items():
        actual = state['accounts'][wallet]
        if a['cash'] != actual['cash'] or a['games'] != actual['games']:
            raise ValueError('fictional_cash_or_market_pnl_replay_mismatch')
        MODEL.verify_account(actual, p['starting_capital_usd'])
    result = evaluation(state, p)
    saved = json.loads((root / 'summary.json').read_bytes())
    if saved.get('evaluation') != result:
        raise ValueError('recomputed_final_or_checkpoint_summary_mismatch')
    if saved.get('report_markdown') != render_report(result, plan['run_id']):
        raise ValueError('human_report_recomputation_mismatch')
    return {'checkpoints_verified': checked['checkpoints'], 'raw_records': checked['seq'],
        'raw_hash': checked['head'], 'paper_fills_reexecuted_from_captured_books': fills,
        'us_settlements_replayed': settlements, 'http_bodies_verified': len(bodies),
        'cash_inventory_market_pnl_and_raw_ledger_equal': True, 'evaluation_recomputed_equal': True,
        'terminal': state['terminal'], 'evaluation': result}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root), indent=2))
