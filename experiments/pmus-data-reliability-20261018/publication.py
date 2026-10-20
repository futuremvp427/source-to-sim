"""Dedicated data-only checkpoint mirror; retry core shared with draft PR 63."""
from __future__ import annotations
import base64, hashlib, json, os, re, tempfile, urllib.error, urllib.parse, urllib.request, time
from pathlib import Path
from durable import atomic_write, restore_events, verify_checkpoints
from quality import canonical
sha=lambda data:hashlib.sha256(data).hexdigest()
class PublicationError(RuntimeError): pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): raise ValueError('redirect_refused')
class GitMirror:
    def __init__(self,run_id,code_sha,root):
        if not re.fullmatch(r'[0-9]{6,20}',str(run_id)) or not re.fullmatch(r'[0-9a-f]{40}',code_sha):
            raise ValueError('invalid_data_run_identity')
        self.root=Path(root)
        self.code_sha=code_sha
        self.token=os.environ.get('GH_TOKEN')
        if not self.token: raise ValueError('missing_checkpoint_token')
        self.p={'repository':'futuremvp427/source-to-sim','study_id':str(run_id)}
        self.base='https://api.github.com/repos/'+self.p['repository']
        self.branch='research/pmus-data-quality-state-'+str(run_id)
        self.folder='data-results/'+str(run_id)+'/'
        self.head=None
        self.pending_commit=None
        self.last_published_fingerprint=None
        self.published={}
        self.pending_files=None
        record=self.root/'publication.json'
        if record.exists():
            saved=json.loads(record.read_bytes())
            if saved['run_id']!=str(run_id) or saved['code_sha']!=code_sha:
                raise ValueError('publication_identity_mismatch')
            for k in ('head','pending_commit','last_published_fingerprint','published','pending_files'):
                setattr(self,k,saved[k])

    def save(self):
        value={k:getattr(self,k) for k in ('head','pending_commit','last_published_fingerprint','published','pending_files')}
        value.update(run_id=self.p['study_id'],code_sha=self.code_sha)
        atomic_write(self.root/'publication.json',canonical(value)+b'\n')

    def restore(self):
        ref=self.ref()
        if not ref: return False
        self.head=ref['object']['sha']
        commit=self.request('/git/commits/'+self.head)
        tree=self.request('/git/trees/'+commit['tree']['sha']+'?recursive=1')
        if tree.get('truncated'): raise ValueError('truncated_checkpoint_tree')
        entries=[e for e in tree['tree'] if e['type']=='blob' and e['path'].startswith(self.folder)]
        if not entries:
            if self.head != self.code_sha:
                raise ValueError('missing_data_checkpoint_files')
            # Branch creation may have succeeded just before runner loss.
            # This is not a measured checkpoint and does not rewind any data.
            self.save()
            return False
        allowed_names=re.compile(r'^(?:plan.json|summary.json|bodies/[0-9a-f]{64}\.xz|checkpoints/[0-9]{6}/(?:manifest.json|raw.jsonl.xz|summary.json))$')
        with tempfile.TemporaryDirectory() as temporary:
            temp=Path(temporary)
            for item in entries:
                name=item['path'][len(self.folder):]
                if not allowed_names.fullmatch(name) or item['size']>8*1024**2:
                    raise ValueError('unexpected_checkpoint_file')
                blob=self.request('/git/blobs/'+item['sha'])
                data=base64.b64decode(blob['content'],validate=False)
                if len(data)!=item['size'] or hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()!=item['sha']:
                    raise ValueError('git_blob_identity_mismatch')
                atomic_write(temp/name,data,immutable=True)
                self.published[name]=sha(data)
            plan=json.loads((temp/'plan.json').read_bytes())
            if plan['run_id']!=self.p['study_id'] or plan['code_sha']!=self.code_sha:
                raise ValueError('restored_plan_identity_mismatch')
            remote=verify_checkpoints(temp)
            events=self.root/'events.jsonl'
            if events.exists():
                from durable import decode_rows
                local,_,_=decode_rows(events.read_bytes())
                common=min(len(local),len(remote['rows']))
                if local[:common]!=remote['rows'][:common]: raise ValueError('local_remote_evidence_divergence')
                if len(local)<len(remote['rows']): raise ValueError('local_evidence_behind_remote_preserve_both')
            for item in entries:
                name=item['path'][len(self.folder):]
                atomic_write(self.root/name,(temp/name).read_bytes(),immutable=name!='summary.json')
            if not events.exists(): restore_events(self.root)
        self.save()
        return True

    def sync(self,journal):
        if self.pending_files is not None:
            files={p:base64.b64decode(d,validate=True) for p,d in self.pending_files.items()}
            self.publish(files,{'checkpoint_number':journal.checkpoint},bootstrap=self.head is None)
            self.published.update({p:sha(d) for p,d in files.items()})
            self.pending_files=None
            self.save()
        files={}
        # Capture one consistent sealed generation; network publication holds
        # no collection lock and cannot block future market observations.
        with journal.lock:
            candidates=[self.root/'plan.json',self.root/'summary.json',*sorted((self.root/'bodies').glob('*.xz')),
                        *sorted((self.root/'checkpoints').glob('[0-9][0-9][0-9][0-9][0-9][0-9]/*'))]
            for path in candidates:
                if not path.is_file() or path.is_symlink(): raise ValueError('unexpected_local_mirror_file')
                name=str(path.relative_to(self.root));data=path.read_bytes()
                if self.published.get(name)!=sha(data): files[name]=data
        if not files: return self.head
        self.pending_files={p:base64.b64encode(d).decode() for p,d in files.items()}
        self.save()
        result=self.publish(files,{'checkpoint_number':journal.checkpoint},bootstrap=self.head is None)
        self.published.update({p:sha(d) for p,d in files.items()})
        self.pending_files=None
        self.save()
        return result

    def request(self, path, method="GET", value=None, missing_ok=False):
        if not path.startswith(("/git/", "/contents/")):
            raise ValueError("GitHub checkpoint endpoint outside allowlist")
        # Blobs/trees are content addressed; repeating the same ref PATCH is
        # idempotent. Do not blindly retry branch creation after an uncertain POST.
        retry_allowed = not (path == "/git/refs" and method == "POST")
        for attempt in range(5):
            request = urllib.request.Request(
                self.base + path, data=canonical(value) if value is not None else None,
                method=method, headers={"Authorization": "Bearer " + self.token,
                    "Accept": "application/vnd.github+json", "User-Agent": "US-paper-checkpoints/1.0",
                    "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"})
            retry, delay = False, min(2 ** attempt, 16)
            try:
                with urllib.request.build_opener(NoRedirect()).open(request, timeout=35) as response:
                    return json.load(response)
            except urllib.error.HTTPError as exc:
                if exc.code == 404 and missing_ok:
                    return None
                rate_limited = exc.code == 403 and (
                    exc.headers.get("X-RateLimit-Remaining") == "0" or exc.headers.get("Retry-After"))
                retry = exc.code in (408, 429, 500, 502, 503, 504) or bool(rate_limited)
                failure = f"GitHub checkpoint request failed: HTTP {exc.code}"
                wait = exc.headers.get("Retry-After")
                if wait is not None:
                    try:
                        delay = max(delay, float(wait))
                    except (TypeError, ValueError):
                        retry = False
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                retry = True
                failure = "GitHub checkpoint transport failed: " + type(exc).__name__
            if not retry or not retry_allowed or attempt == 4 or delay > 30:
                raise PublicationError(failure) from None
            time.sleep(delay)


    def ref(self):
        return self.request("/git/ref/heads/" + self.branch, missing_ok=True)


    def content(self, path):
        item = self.request("/contents/" + self.folder + path + "?ref=" + urllib.parse.quote(self.head or self.branch, safe=""))
        if item.get("encoding") != "base64":
            blob = self.request("/git/blobs/" + item["sha"])
            return base64.b64decode(blob["content"])
        return base64.b64decode(item["content"])


    def _finish_pending(self):
        pending = self.pending_commit
        self.save()  # Persist the exact commit before an ambiguous ref update.
        try:
            self.request("/git/refs/heads/" + self.branch, "PATCH",
                         {"sha": pending["sha"], "force": False})
        except PublicationError:
            # A timeout/500 may occur after GitHub moved the ref. Read it back
            # before deciding that this exact sealed checkpoint was lost.
            observed = self.ref()
            if not observed or observed["object"]["sha"] != pending["sha"]:
                raise
        self.head = pending["sha"]
        self.last_published_fingerprint = pending["fingerprint"]
        self.pending_commit = None
        self.save()
        return self.head


    def publish(self, files, state, bootstrap=False):
        if any(Path(path).is_absolute() or ".." in Path(path).parts for path in files):
            raise ValueError("checkpoint file path outside study folder")
        fingerprint = sha(canonical({path: sha(data) for path, data in sorted(files.items())}))
        ref = self.ref()
        if (ref and ref["object"]["sha"] == self.head
                and fingerprint == self.last_published_fingerprint):
            return self.head
        if self.pending_commit is not None:
            if fingerprint != self.pending_commit["fingerprint"]:
                raise ValueError("pending checkpoint bytes changed")
            if ref and ref["object"]["sha"] == self.pending_commit["sha"]:
                self.head = self.pending_commit["sha"]
                self.last_published_fingerprint = fingerprint
                self.pending_commit = None
                return self.head
            if not ref or ref["object"]["sha"] != self.head:
                raise ValueError("checkpoint branch changed concurrently; refusing overwrite")
            return self._finish_pending()
        if bootstrap:
            if ref:
                raise ValueError("study checkpoint branch already exists; duplicate bootstrap forbidden")
            self.request("/git/refs", "POST", {"ref": "refs/heads/" + self.branch, "sha": self.code_sha})
            self.head = self.code_sha
        elif not ref or ref["object"]["sha"] != self.head:
            raise ValueError("checkpoint branch changed concurrently; refusing overwrite")
        commit = self.request("/git/commits/" + self.head)
        blobs, tree = {}, []
        for path, data in files.items():
            digest = sha(data)
            if digest not in blobs:
                blobs[digest] = self.request("/git/blobs", "POST", {
                    "content": base64.b64encode(data).decode(), "encoding": "base64"})["sha"]
            tree.append({"path": self.folder + path, "mode": "100644", "type": "blob", "sha": blobs[digest]})
        new_tree = self.request("/git/trees", "POST", {"base_tree": commit["tree"]["sha"], "tree": tree})
        new_commit = self.request("/git/commits", "POST", {
            "message": f"Paper checkpoint {state['checkpoint_number']} [{self.p['study_id']}]",
            "tree": new_tree["sha"], "parents": [self.head]})
        # Keep the exact commit for an ambiguous PATCH response or an explicit
        # retry. A normal fast-forward still rejects a concurrent sibling.
        self.pending_commit = {"sha": new_commit["sha"], "fingerprint": fingerprint}
        return self._finish_pending()

