"""Drive the existing read-only live gate. Never initializes paper accounts."""
from __future__ import annotations
import argparse
import concurrent.futures
import hashlib
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace
from core import ROOT, MODEL, canonical, digest, protocol
import sys
sys.path.insert(0,str(ROOT.parent/'pmus-live-gate-20261022'))
import live_gate as gate
from durable import DurableJournal, atomic_write
from publication import GitMirror

class QualificationMirror(GitMirror):
    def __init__(self,run_id,code_sha,root):
        super().__init__(run_id,code_sha,root)
        phase=Path(root).name.removesuffix('-round-trip')
        if phase not in ('preflight','live','wait_00','wait_01','resources'):
            raise ValueError('unexpected_qualification_phase')
        self.branch='research/pmus-expanded-qualification-state-'+str(run_id)
        self.folder='qualification-results/'+str(run_id)+'/'+phase+'/'
        # Each phase shares the branch but has a separate immutable plan/journal.
        if self.head is None:
            existing=self.ref()
            if existing:
                self.head=existing['object']['sha']
                if not Path(root).name.endswith('-round-trip'):
                    present=self.request('/contents/'+self.folder+'plan.json?ref='+self.head,missing_ok=True)
                    if present:
                        raise ValueError('qualification_phase_already_published_no_restart')

def check_watch():
    watch=json.loads((gate.ROOT/'watch.json').read_bytes())
    p=protocol()
    if (watch.get('source_wallets')!=p['wallets']
            or watch.get('paper_protocol_sha256')!=hashlib.sha256((ROOT/'protocol.json').read_bytes()).hexdigest()
            or len(watch['markets'])!=2):
        raise ValueError('qualification_watch_cohort_or_protocol_changed')
    return watch

def resources(args):
    """One bounded public source-body/latency/storage measurement, no accounts."""
    import shutil
    from core import PaperJournal, CollectorLog, StrictNetwork, frozen, transport
    p=protocol();output=args.output/'resources';journal=PaperJournal(output)
    mirror=QualificationMirror(args.run_id,args.code_sha,output)
    end=int(time.time());start=end-p['feed_overlap_seconds']
    plan={'mode':'resource_snapshot','run_id':args.run_id,'code_sha':args.code_sha,
        'source_window_start':start,'source_window_end':end,'paper_epoch_initialized':False}
    atomic_write(output/'plan.json',canonical(plan)+b'\n',immutable=True)
    stats={'http_calls':0,'http_errors':0};log=CollectorLog(journal,stats);net=StrictNetwork(p,log)
    began=time.time();results=[]
    try:
        def read(wallet):
            at=time.time()
            rows,received=frozen.pages(net,'https://data-api.polymarket.com/v2/trades',
                {'user':wallet['address'],'taker_only':'false','limit':1000,'start':start,'end':end},wallet['address'])
            if any(not start<=float(r['timestamp'])<=end for r in rows):
                raise ValueError('resource_snapshot_source_window_violation')
            return {'wallet':wallet['address'],'name':wallet['name'],'complete_pagination':True,
                'returned_executions':len(rows),'latency_seconds':time.time()-at,'last_successful_poll_at':received,
                'latest_returned_execution_at':max((float(r['timestamp']) for r in rows),default=None)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(read,p['wallets']))
        for row in journal.rows:
            if row['kind']=='paper_http':
                r=row['payload'];issues,_=transport({**r,'status':r['http_status']},20)
                if issues:raise ValueError('resource_snapshot_stale_source:'+','.join(issues))
        projected_source=journal.body_total*(p['entry_collection_hours']*3600/p['poll_seconds'])
        summary={'mode':'resource_snapshot','run_id':args.run_id,'code_sha':args.code_sha,
            'actual_started_at':began,'actual_completed_at':time.time(),'wallets':results,
            'actual_compressed_source_bytes':journal.body_total,'actual_wal_bytes':journal.total,
            'source_only_extrapolated_full_collection_compressed_bytes':projected_source,
            'extrapolation_is_not_future_volume_or_resource_guarantee':True,
            'compressed_evidence_bound_bytes':p['maximum_compressed_evidence_bytes'],
            'wal_bound_bytes':p['maximum_wal_bytes'],'free_runner_disk_bytes':shutil.disk_usage(output).free,
            'artifact_uploads':0,'cache_uploads':0,'standard_public_runner_only':True,
            'source_snapshot_extrapolation_within_60pct_body_budget':projected_source<=.6*p['maximum_compressed_evidence_bytes'],
            'paper_epoch_initialized':False,'paper_entries':0,'profitability_evaluated':False}
        journal.add('resource_snapshot',summary);journal.seal(summary);mirror.sync(journal)
        print('REAL_PUBLIC_RESOURCE_SNAPSHOT='+json.dumps(summary),flush=True)
    finally:journal.close()
    if not summary['source_snapshot_extrapolation_within_60pct_body_budget']:
        raise ValueError('current_source_snapshot_extrapolation_exceeds_preentry_storage_margin')
    return 0

def wait(args):
    watch=check_watch()
    output=args.output/args.phase
    journal=DurableJournal(output)
    mirror=QualificationMirror(args.run_id,args.code_sha,output)
    plan={'mode':'qualification_wait','run_id':args.run_id,'code_sha':args.code_sha,
          'watch':watch,'started_at':time.time(),'paper_epoch_initialized':False}
    atomic_write(output/'plan.json',canonical(plan)+b'\n',immutable=True)
    client=gate.EventClient(journal)
    deadline=min(time.time()+args.seconds,MODEL.stamp(watch['latest_launch_utc']))
    ready=False
    try:
        while time.time()<deadline:
            scheduled=time.time()
            # Only public event phase reads during waiting. No source signals or entries.
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures={m['market_slug']:pool.submit(client.fresh,m,scheduled) for m in watch['markets']}
                results={m['market_slug']:gate.phase(futures[m['market_slug']].result(),m) for m in watch['markets']}
            ready=all(x['usable'] for x in results.values())
            summary={'mode':'qualification_wait','run_id':args.run_id,'code_sha':args.code_sha,
                'both_frozen_games_fresh_explicitly_live':ready,'observed_at':time.time(),
                'markets':results,'paper_epoch_initialized':False,'paper_entries':0,
                'live_gate_passed':False,'wait_is_not_a_live_gate_or_paper_start':True}
            journal.add('qualification_live_window_check',summary)
            journal.seal(summary)
            mirror.sync(journal)
            print('QUALIFICATION_WAIT='+json.dumps(summary),flush=True)
            if ready:break
            # The dedicated bounded runner remains responsive; nothing earns gate ticks.
            gate.threading.Event().wait(min(60,max(0,deadline-time.time())))
    finally:
        journal.close()
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('ready='+str(ready).lower()+'\n')
    return 0

def observe(args):
    watch=check_watch()
    gate.GitMirror=QualificationMirror
    if args.phase=='live':
        # The saved wait response is never reused as live proof at gate launch.
        class MemoryJournal:
            def __init__(self):self.rows=[]
            def add(self,kind,payload):
                self.rows.append({'kind':kind,'payload':payload})
                return {'seq':len(self.rows),'hash':digest(payload)}
        before=MemoryJournal();client=gate.EventClient(before);scheduled=time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            fs={m['market_slug']:pool.submit(client.fresh,m,scheduled) for m in watch['markets']}
            results={m['market_slug']:gate.phase(fs[m['market_slug']].result(),m) for m in watch['markets']}
        if not all(x['usable'] for x in results.values()):
            raise ValueError('both_frozen_games_not_fresh_explicitly_live_before_gate')
        atomic_write(args.output/'live-pre-entry-public-check.json',canonical({'records':before.rows,'phases':results})+b'\n',immutable=True)
    try:
        gate.run(SimpleNamespace(output=args.output/args.phase,run_id=args.run_id,
            code_sha=args.code_sha,mode='preflight' if args.phase=='preflight' else 'live',
            initial_http_rows=before.rows if args.phase=='live' else []))
    except RuntimeError as error:
        if args.phase!='preflight' or str(error)!='gate_not_passed_no_paper_start':
            raise
        result=json.loads((args.output/'preflight/verification.json').read_bytes())
        if result.get('failure'):
            raise
        # A stale pregame quote is disclosed; it neither certifies nor predicts
        # the later live window. Only the once-only actual LIVE gate can pass.
        print('PREGAME_DIAGNOSTIC_NOT_QUALIFIED='+json.dumps(result),flush=True)
    return 0

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--phase',choices=('preflight','wait_00','wait_01','live','resources'),required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--run-id',required=True);p.add_argument('--code-sha',required=True)
    p.add_argument('--seconds',type=int,default=18000)
    args=p.parse_args()
    if args.phase=='resources':return resources(args)
    return wait(args) if args.phase.startswith('wait_') else observe(args)

if __name__=='__main__':raise SystemExit(main())
