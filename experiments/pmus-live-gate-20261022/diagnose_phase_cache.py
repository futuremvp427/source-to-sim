#!/usr/bin/env python3
"""Four fixed public HTTP samples only; never starts a gate or paper account."""
import argparse
import concurrent.futures
import hashlib
import json
import time
from pathlib import Path

import live_gate as g


def diagnose(output):
    watch = json.loads((g.ROOT / 'watch.json').read_bytes())
    journal = g.DurableJournal(output)
    samples = []
    started = time.time()
    client = g.EventClient(journal)
    journal.add('phase_diagnostic_plan', {'started_at': started, 'planned_ticks': 4,
        'interval_seconds': 20, 'watch': watch, 'gate_epoch_started': False,
        'paper_epoch_started': False, 'real_orders': 0, 'private_account_requests': 0})
    try:
        for tick in range(4):
            scheduled = started + tick * 20
            delay = scheduled - time.time()
            if delay > 0: time.sleep(delay)
            def sample(item):
                response = client.fresh(item, scheduled)
                issues, detail = g.transport(response, 20)
                issues += g.event_identity_issues(response, item)
                if response['received_at'] > response['phase_read_deadline']:
                    issues.append('phase_read_deadline_elapsed')
                return {'event_slug': item['event_slug'], 'scheduled_at': scheduled,
                        'selected_evidence': response['evidence'],
                        'attempt_evidence': response['attempt_evidence'],
                        'transport_usable': not issues, 'issues': issues, 'transport': detail,
                        'phase': g.phase(response, item)}
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                markets = list(pool.map(sample, watch['markets']))
            result = {'tick': tick, 'scheduled_at': scheduled, 'markets': markets}
            journal.add('phase_diagnostic_cycle', result)
            samples.append(result)
            print(json.dumps(result), flush=True)
        summary = {'mode': 'phase_http_diagnostic_only', 'started_at': started,
            'evaluated_at': time.time(), 'planned_ticks': 4, 'actual_cycles': len(samples),
            'events': {i['event_slug']: {
                'valid_transport_samples': sum(x['transport_usable'] for c in samples for x in c['markets'] if x['event_slug'] == i['event_slug']),
                'actual_live_samples': sum(x['phase']['usable'] for c in samples for x in c['markets'] if x['event_slug'] == i['event_slug']),
                'fallback_samples': sum(len(x['attempt_evidence']) > 1 for c in samples for x in c['markets'] if x['event_slug'] == i['event_slug'])}
                for i in watch['markets']},
            'live_gate_passed': False, 'paper_entries': 0, 'real_orders': 0,
            'private_account_requests': 0, 'profitability_evaluated': False}
        journal.seal(summary)
        checked = g.verify_checkpoints(output)
        g.verify_extra_http(checked['rows'])
        assert checked['rows'] == journal.rows
        print('PHASE_DIAGNOSTIC=' + json.dumps(summary), flush=True)
    finally:
        journal.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    diagnose(parser.parse_args().output)
