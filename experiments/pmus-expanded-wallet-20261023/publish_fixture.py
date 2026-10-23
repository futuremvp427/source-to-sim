"""Publish and restore a clearly synthetic existing-collector fixture."""
import argparse
import json
import sys
from pathlib import Path
ROOT=Path(__file__).parent
sys.path.insert(0,str(ROOT.parent/'pmus-four-wallet-unified-20261022'))
import core
import run
from verify import verify

class FixtureMirror(run.PaperMirror):
    def __init__(self,run_id,code_sha,root):
        super().__init__(run_id,code_sha,root)
        self.branch='research/pmus-expanded-qualification-state-'+str(run_id)
        self.folder='qualification-results/'+str(run_id)+'/fixture/'
        existing=self.ref()
        if existing:self.head=existing['object']['sha']

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--run-id',required=True);parser.add_argument('--code-sha',required=True)
    args=parser.parse_args()
    source=args.source/'fixture-journal'
    plan=json.loads((source/'plan.json').read_bytes())
    if (plan.get('synthetic_fixture_only') is not True or plan['run_id']!=args.run_id
            or plan['code_sha']!=args.code_sha):
        raise ValueError('synthetic_fixture_run_or_code_identity_mismatch')
    journal=core.PaperJournal(source,resume=True)
    original=verify(source)
    mirror=FixtureMirror(args.run_id,args.code_sha,source)
    if mirror.head:
        present=mirror.request('/contents/'+mirror.folder+'plan.json?ref='+mirror.head,missing_ok=True)
        if present:raise ValueError('existing_fixture_publication_refuse_overwrite')
    mirror.sync(journal)
    restored=args.source/'remote-published-fixture'
    remote=FixtureMirror(args.run_id,args.code_sha,restored)
    if not remote.restore():raise ValueError('published_fixture_missing')
    actual=verify(restored)
    if actual!=original:raise ValueError('actual_publication_restore_evaluator_mismatch')
    proof={'synthetic_fixture_only':True,'not_wallet_performance_or_live_qualification':True,
        'exact_workflow_run':args.run_id,'collector_code_sha':args.code_sha,
        'published_commit':remote.head,'observed_git_blobs_verified':len(remote.published),
        'remote_round_trip_evaluation_equal':True,'actual_restored_raw_hash':actual['raw_hash'],
        'paper_fills_reexecuted':actual['paper_fills_reexecuted_from_captured_books'],
        'us_settlements_replayed':actual['us_settlements_replayed']}
    journal.add('synthetic_collector_publication_restore_proof',proof)
    state=core.replay(journal.rows,core.protocol())
    run.seal(journal,state,plan,core.protocol(),segment_complete=True)
    mirror.sync(journal);journal.close()
    print('SYNTHETIC_PUBLISHED_COLLECTOR_FIXTURE='+json.dumps(proof),flush=True)

if __name__=='__main__':main()
