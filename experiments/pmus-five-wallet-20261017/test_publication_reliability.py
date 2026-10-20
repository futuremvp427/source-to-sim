"""Offline failure injection. No venue, GitHub or credential validation calls."""
import copy
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

import collector
from collector import Collector
from model import canonical, sha
from persistence import PublicationError, Publisher, atomic_write
from test_study import P, state
from verify_checkpoints import verify


def http_error(code, headers=None):
    return urllib.error.HTTPError('https://api.github.com/test', code, 'failure', headers or {}, io.BytesIO(b'{}'))


class RequestRecovery(unittest.TestCase):
    def publisher(self):
        with patch.dict('os.environ', {'GH_TOKEN': 'unit-test-placeholder'}):
            return Publisher(P, 'a'*40)

    def test_transient_blob_500_retries_identical_payload(self):
        opener=Mock();opener.open.side_effect=[http_error(500),io.BytesIO(b'{"sha":"saved"}')]
        with patch('persistence.urllib.request.build_opener',return_value=opener),patch('persistence.time.sleep') as sleep:
            value=self.publisher().request('/git/blobs','POST',{'content':'frozen','encoding':'base64'})
        self.assertEqual(value['sha'],'saved')
        self.assertEqual(opener.open.call_count,2)
        self.assertEqual(opener.open.call_args_list[0].args[0].data,opener.open.call_args_list[1].args[0].data)
        sleep.assert_called_once_with(1)

    def test_permission_failure_is_not_retried(self):
        opener=Mock();opener.open.side_effect=http_error(401)
        with patch('persistence.urllib.request.build_opener',return_value=opener),patch('persistence.time.sleep') as sleep:
            with self.assertRaisesRegex(PublicationError,'HTTP 401'):self.publisher().request('/git/blobs','POST',{})
        self.assertEqual(opener.open.call_count,1);sleep.assert_not_called()

    def test_rate_limit_wait_is_honored(self):
        opener=Mock();opener.open.side_effect=[http_error(429,{'Retry-After':'2'}),io.BytesIO(b'{}')]
        with patch('persistence.urllib.request.build_opener',return_value=opener),patch('persistence.time.sleep') as sleep:
            self.publisher().request('/git/trees','POST',{})
        sleep.assert_called_once_with(2)

    def test_long_rate_limit_preserves_control_without_hammering(self):
        opener=Mock();opener.open.side_effect=http_error(429,{'Retry-After':'120'})
        with patch('persistence.urllib.request.build_opener',return_value=opener),patch('persistence.time.sleep') as sleep:
            with self.assertRaises(PublicationError):self.publisher().request('/git/trees','POST',{})
        self.assertEqual(opener.open.call_count,1);sleep.assert_not_called()

    def test_timeout_retries_with_sanitized_error(self):
        opener=Mock();opener.open.side_effect=[TimeoutError(),io.BytesIO(b'{}')]
        with patch('persistence.urllib.request.build_opener',return_value=opener),patch('persistence.time.sleep'):
            self.publisher().request('/git/ref/heads/'+P['state_branch'])
        self.assertEqual(opener.open.call_count,2)

    def test_persistent_outage_is_bounded(self):
        opener=Mock();opener.open.side_effect=http_error(503)
        with patch('persistence.urllib.request.build_opener',return_value=opener),patch('persistence.time.sleep') as sleep:
            with self.assertRaises(PublicationError):self.publisher().request('/git/blobs','POST',{})
        self.assertEqual(opener.open.call_count,5)
        self.assertEqual([c.args[0] for c in sleep.call_args_list],[1,2,4,8])

    def test_uncertain_branch_creation_is_not_replayed(self):
        opener=Mock();opener.open.side_effect=http_error(500)
        with patch('persistence.urllib.request.build_opener',return_value=opener),patch('persistence.time.sleep') as sleep:
            with self.assertRaises(PublicationError):self.publisher().request('/git/refs','POST',{})
        self.assertEqual(opener.open.call_count,1);sleep.assert_not_called()

    def test_checkpoint_content_reads_use_observed_immutable_head(self):
        p=self.publisher();p.head='b'*40
        p.request=Mock(return_value={'encoding':'base64','content':'Zml4ZWQ='})
        self.assertEqual(p.content('latest/manifest.json'),b'fixed')
        self.assertTrue(p.request.call_args.args[0].endswith('?ref='+'b'*40))


class SealedEvidenceRecovery(unittest.TestCase):
    def test_failed_publication_preserves_verifiable_checkpoint_and_exact_retry(self):
        with tempfile.TemporaryDirectory() as work:
            c=Collector(state(),P,work);publisher=Mock();publisher.head='b'*40
            publisher.publish.side_effect=[PublicationError('HTTP 500'),'c'*40]
            with self.assertRaises(PublicationError):c.publish(publisher)
            root=Path(work)/'output'
            pending=json.loads((root/'PENDING_PUBLICATION.json').read_bytes())
            self.assertEqual(pending['checkpoint'],1)
            self.assertFalse(pending['automatic_rewind_allowed'])
            for name,digest in pending['files'].items():self.assertEqual(sha((root/name).read_bytes()),digest)
            self.assertEqual(verify(root)['checkpoints_verified'],1)
            original=(root/'checkpoints/000001/state.json.xz').read_bytes()
            c.publish(publisher)
            self.assertEqual(c.s['checkpoint_number'],1)
            self.assertEqual((root/'checkpoints/000001/state.json.xz').read_bytes(),original)
            self.assertEqual(publisher.publish.call_args_list[0].args[0],publisher.publish.call_args_list[1].args[0])
            self.assertFalse((root/'PENDING_PUBLICATION.json').exists())
            self.assertEqual(json.loads((root/'PUBLICATION_RECEIPT.json').read_bytes())['commit'],'c'*40)
            c.journal.file.close()

    def test_main_does_not_write_fatal_row_into_closed_journal_or_mark_terminal(self):
        with tempfile.TemporaryDirectory() as work:
            s=state();s.update(segment=-1,segment_complete=True)
            publisher=Mock();publisher.head='b'*40;publisher.load.return_value=s
            publisher.publish.side_effect=PublicationError('HTTP 500')
            argv=['collector.py','--segment','0','--seconds','0','--work',work]
            with patch('collector.Publisher',return_value=publisher),patch('sys.argv',argv),patch.dict('os.environ',{'GITHUB_SHA':'a'*40}):
                with self.assertRaisesRegex(PublicationError,'HTTP 500'):collector.main()
            self.assertFalse(s['terminal']);self.assertIsNone(s['fatal_error'])
            self.assertEqual(s['checkpoint_number'],1)
            self.assertEqual(verify(Path(work)/'output')['checkpoints_verified'],1)

    def test_changed_pending_state_is_rejected_without_rewriting_evidence(self):
        with tempfile.TemporaryDirectory() as work:
            c=Collector(state(),P,work);publisher=Mock();publisher.head='b'*40
            publisher.publish.side_effect=PublicationError('HTTP 500')
            with self.assertRaises(PublicationError):c.publish(publisher)
            c.s['cycles']+=1
            with self.assertRaisesRegex(ValueError,'state changed'):c.publish(publisher)
            self.assertEqual(c.s['checkpoint_number'],1)

    def test_immutable_file_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'sealed.bin';atomic_write(path,b'original',immutable=True)
            with self.assertRaisesRegex(ValueError,'immutable'):atomic_write(path,b'different',immutable=True)
            self.assertEqual(path.read_bytes(),b'original')


class AmbiguousRefRecovery(unittest.TestCase):
    def test_ref_timeout_after_success_does_not_duplicate_checkpoint(self):
        with patch.dict('os.environ',{'GH_TOKEN':'unit-test-placeholder'}):p=Publisher(P,'a'*40)
        p.head='b'*40;head=['b'*40];calls=[]
        def request(path,method='GET',value=None,missing_ok=False):
            calls.append((path,method,value))
            if path.startswith('/git/ref/heads/'):return {'object':{'sha':head[0]}}
            if path=='/git/commits/'+'b'*40:return {'tree':{'sha':'d'*40}}
            if path=='/git/blobs':return {'sha':'e'*40}
            if path=='/git/trees':return {'sha':'f'*40}
            if path=='/git/commits':return {'sha':'c'*40}
            if path.startswith('/git/refs/heads/'):
                self.assertFalse(value['force']);head[0]=value['sha'];raise PublicationError('timeout after update')
            raise AssertionError(path)
        p.request=request
        self.assertEqual(p.publish({'checkpoint.bin':b'evidence'},{'checkpoint_number':1}),'c'*40)
        self.assertIsNone(p.pending_commit)
        self.assertEqual(sum(method=='POST' and path=='/git/commits' for path,method,_ in calls),1)
        self.assertEqual(p.publish({'checkpoint.bin':b'evidence'},{'checkpoint_number':1}),'c'*40)
        self.assertEqual(sum(method=='POST' and path=='/git/commits' for path,method,_ in calls),1)

    def test_concurrent_branch_change_is_never_overwritten(self):
        with patch.dict('os.environ',{'GH_TOKEN':'unit-test-placeholder'}):p=Publisher(P,'a'*40)
        p.head='b'*40;p.pending_commit={'sha':'c'*40,'fingerprint':sha(canonical({'x':sha(b'v')}))}
        p.request=Mock(return_value={'object':{'sha':'f'*40}})
        with self.assertRaisesRegex(ValueError,'concurrently'):p.publish({'x':b'v'},{'checkpoint_number':1})
        self.assertEqual(p.head,'b'*40)
        self.assertEqual(p.request.call_count,1)


if __name__=='__main__':unittest.main()
