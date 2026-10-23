"""Synthetic rejection/recovery tests. Never launch evidence or wallet returns."""
import copy
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).parent
sys.path.insert(0,str(ROOT.parent/'pmus-four-wallet-unified-20261022'))
import core
import run
from verify import verify
sys.path.insert(0,str(ROOT.parent/'pmus-live-gate-20261022'))
import live_gate
import qualification
spec=importlib.util.spec_from_file_location('expanded_readiness',ROOT/'readiness.py')
readiness=importlib.util.module_from_spec(spec);spec.loader.exec_module(readiness)

class ExpandedTests(unittest.TestCase):
    def test_exact_12_independent_accounts_and_unchanged_final_economic_gates(self):
        p=core.protocol();self.assertEqual(len(p['wallets']),12)
        self.assertEqual(len({w['address'] for w in p['wallets']}),12)
        self.assertEqual(p['starting_capital_usd'],'1000')
        self.assertEqual(p['maximum_contracts_per_market'],'10')
        self.assertEqual((p['entry_collection_hours'],p['maximum_settlement_drain_hours']),(48,48))
        self.assertEqual(p['minimum_completed_distinct_markets'],30)
        self.assertEqual(p['minimum_coverage'],.95)
        self.assertEqual(p['preliminary_reporting_milestones'],[10,20])
        self.assertEqual(len(core.initial_state(p,'a'*40,1000)['accounts']),12)

    def test_new_contract_watch_and_bundle_bind_to_current_prepared_code(self):
        p=core.protocol();data=(ROOT/'requirements.json').read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(),p['readiness_contract_sha256'])
        watch=qualification.check_watch()
        self.assertEqual(watch['source_wallets'],p['wallets'])
        self.assertEqual(len(run.bundle_digest()),64)
        self.assertTrue(all(live_gate.event_url_allowed('https://gateway.polymarket.us/v1/events/slug/'+m['event_slug']) for m in watch['markets']))

    def test_each_of_12_sources_must_pass_actual_live_gate(self):
        p=core.protocol();watch=qualification.check_watch()
        plan={'run_id':'12345678901','code_sha':'a'*40,'mode':'live','watch':watch,
            'duration_seconds':1800,'started_at':1000,'source_wallets':p['wallets']}
        rows=[{'kind':'live_gate_cycle','payload':{'tick':t,
            'markets':{m['market_slug']:{'phase':{'usable':True},'book':{'kind':'book','usable':True,
                'stream':{'usable':True},'comparison':{'matched':True,'book_at':1000+t*20}}} for m in watch['markets']},
            'sources':{w['address']:{'usable':True} for w in p['wallets']}}} for t in range(90)]
        self.assertTrue(live_gate.summarize(plan,rows,2800)['live_gate_passed'])
        for row in rows[:5]:row['payload']['sources'][p['wallets'][-1]['address']]['usable']=False
        self.assertFalse(live_gate.summarize(plan,rows,2800)['live_gate_passed'])

    def test_missing_packet_refuses_before_paper_directory_or_epoch(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)/'paper'
            args=SimpleNamespace(segment=0,output=target,run_id='12345678901',code_sha='a'*40,seconds=20)
            with patch.object(run,'require_qualification',side_effect=ValueError('missing_independent_packet')):
                self.assertEqual(run.collect(args),1)
            self.assertFalse(target.exists())

    def test_unknown_future_volume_requires_explicit_exploratory_history_policy(self):
        data=(ROOT/'requirements.json').read_bytes();req=json.loads(data);req['requirements_sha256']=hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);f=root/'proof.json';f.write_bytes(b'{"synthetic_schema_fixture_only":true}\n')
            proof={'file':'proof.json','sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'bytes':f.stat().st_size,'independently_verified':True}
            packet={'collector_code_sha':'a'*40,'paper_protocol_sha256':'b'*64,'requirements_sha256':req['requirements_sha256'],
                'reference_protocol_sha256':req['reference_protocol_sha256'],'wallets':req['wallets'],
                'entry_collection_hours':48,'maximum_settlement_drain_hours':48,'proofs_are_test_fixtures':False,
                'checks':{n:{'status':'passed','code_sha':'a'*40,'proof':proof} for n in req['required_checks']},
                'final_columns_demonstrated':req['required_final_columns'],
                'live_gate':{'live_gate_passed':True,'completed_full_window':True,'actual_elapsed_seconds':1800,
                    'planned_ticks_per_market':90,'run_id':'12345678901','proof':proof,
                    'markets':{s:{'valid_live_quote_ticks':86,'matched_distinct_book_timestamps':3} for s in req['live_gate_markets']},
                    'source_valid_ticks':{a:86 for a in req['wallets'].values()}},
                'sample_plan':{'independently_reviewed':True,'proof':proof,'forecasts_are_not_guarantees':True,
                    'policy':req['pre_entry_sample_policy'],'prospective_completed_market_counts_unknown':True,
                    'no_guaranteed_30_or_profit':True,'historical_us_associations':{a:{'distinct_us_associations':0,
                        'complete_history_reviewed':True} for a in req['wallets'].values()}}}
            self.assertTrue(readiness.assess(req,packet,root)['launch_ready'])
            packet['sample_plan'].pop('no_guaranteed_30_or_profit')
            self.assertFalse(readiness.assess(req,packet,root)['launch_ready'])
            packet['live_gate']['live_gate_passed']=False
            self.assertIn('actual_live_gate_not_yet_verified',readiness.assess(req,packet,root)['blockers'])

    def make_published_fixture(self,root):
        p=core.protocol();source=root/'source';j=core.PaperJournal(source)
        state=core.initial_state(p,'a'*40,1000)
        state.update(last_cycle_at=1020,last_tick=1,cycles=1,segment_complete=True)
        j.add('paper_initial_state',state)
        plan={'run_id':'12345678901','code_sha':'a'*40,'protocol_sha256':state['protocol_sha256']}
        core.atomic_write(source/'plan.json',core.canonical(plan),immutable=True)
        run.seal(j,state,plan,p,segment_complete=True);j.close()
        folder='paper-results/'+p['study_id']+'/'
        files={folder+str(f.relative_to(source)):f.read_bytes() for f in source.rglob('*') if f.is_file()
            and (f.name in ('plan.json','summary.json') or 'checkpoints' in f.parts)}
        entries=[{'path':name,'type':'blob','size':len(data),'sha':hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()} for name,data in files.items()]
        return state,files,entries

    def remote_restore(self,root,corrupt=False):
        state,files,entries=self.make_published_fixture(root)
        target=root/'restored';head='b'*40
        def request(self,path,*args,**kwargs):
            if '/git/ref/' in path:return {'object':{'sha':head}}
            if path=='/git/commits/'+head:return {'tree':{'sha':'c'*40}}
            if '/git/trees/' in path:return {'tree':entries,'truncated':False}
            raise AssertionError(path)
        class Response:
            def __init__(self,data):self.data=data
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,size):return self.data
        class Opener:
            def open(self,req,timeout):
                prefix='https://raw.githubusercontent.com/futuremvp427/source-to-sim/'+head+'/'
                if not req.full_url.startswith(prefix):raise AssertionError('unobserved download host/commit')
                data=files[req.full_url[len(prefix):]]
                return Response(data+b'!' if corrupt else data)
        with patch.dict(os.environ,{'GH_TOKEN':'synthetic-test-only'}),patch.object(run.PaperMirror,'request',request),patch.object(run.urllib.request,'build_opener',return_value=Opener()):
            mirror=run.PaperMirror('12345678901','a'*40,target)
            self.assertTrue(mirror.restore())
        self.assertEqual(verify(target)['evaluation']['cycles'],1)
        restored=core.PaperJournal(target,resume=True)
        self.assertEqual(core.replay(restored.rows,core.protocol()),state);restored.close()
        return target

    def test_restore_from_observed_immutable_bytes_replays_same_run_without_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:self.remote_restore(Path(tmp))

    def test_changed_downloaded_blob_is_rejected_before_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError,'remote_git_blob_identity_mismatch'):
                self.remote_restore(Path(tmp),corrupt=True)

if __name__=='__main__':unittest.main()
