"""Compressed evidence and checkpoints, published only to the dedicated study branch."""
from __future__ import annotations

import base64
import json
import lzma
import os
import tempfile
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from model import canonical, sha, verify_account


class PublicationError(RuntimeError):
    """Publication failed; the sealed local evidence must remain untouched."""


def atomic_write(path, data, immutable=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if immutable and path.exists():
        if path.read_bytes() != data:
            raise ValueError("refusing to replace an immutable checkpoint")
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".checkpoint-", delete=False) as out:
            temporary = Path(out.name)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        temporary = None
        descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class Journal:
    def __init__(self, directory, state):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.state = state
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.start_hash = self.state["raw_hash"]
        self.start_seq = self.state["raw_seq"]
        self.path = self.directory / "current-raw.jsonl.xz"
        self.file = lzma.open(self.path, "wb", preset=6)

    def add(self, kind, payload):
        with self.lock:
            row = {"seq": self.state["raw_seq"] + 1, "prev_hash": self.state["raw_hash"],
                   "kind": kind, "payload": payload}
            row["hash"] = sha(canonical(row))
            encoded = canonical(row) + b"\n"
            self.file.write(encoded)
            self.state["raw_hash"] = row["hash"]
            self.state["raw_seq"] = row["seq"]
            self.state["raw_uncompressed_bytes"] += len(encoded)
            if self.state["raw_uncompressed_bytes"] > 16 * 1024**3:
                raise RuntimeError("uncompressed evidence bound reached; preserve checkpoint")
        return payload

    def close_chunk(self):
        self.file.close()
        return {"raw_previous_hash": self.start_hash, "raw_start_seq": self.start_seq + 1,
                "raw_end_seq": self.state["raw_seq"], "raw_final_hash": self.state["raw_hash"],
                "raw_records": self.state["raw_seq"] - self.start_seq,
                "raw_sha256": sha(self.path.read_bytes())}


def verify_raw(data, manifest):
    previous, seq = manifest["raw_previous_hash"], manifest["raw_start_seq"] - 1
    for line in lzma.decompress(data).splitlines():
        row = json.loads(line)
        actual = row.pop("hash")
        if row["prev_hash"] != previous or row["seq"] != seq + 1 or sha(canonical(row)) != actual:
            raise ValueError("raw hash chain or sequence mismatch")
        if row["kind"] == "http":
            p = row["payload"]
            body = base64.b64decode(p["raw_base64"], validate=True)
            if sha(body) != p["body_sha256"] or len(body) != p["body_bytes"]:
                raise ValueError("HTTP raw-body digest mismatch")
        previous, seq = actual, row["seq"]
    if previous != manifest["raw_final_hash"] or seq != manifest["raw_end_seq"]:
        raise ValueError("raw checkpoint terminal mismatch")
    return True


def checkpoint(state, protocol, journal, summary, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for account in state["accounts"].values():
        verify_account(account, protocol["starting_capital_usd"])
    state["checkpoint_number"] += 1
    journal.add("checkpoint", {"number": state["checkpoint_number"], "at": state["last_cycle_at"],
                               "segment": state["segment"], "segment_complete": state["segment_complete"]})
    raw_info = journal.close_chunk()
    raw_data = journal.path.read_bytes()
    state["raw_compressed_bytes"] += len(raw_data)
    if state["raw_compressed_bytes"] > protocol["maximum_compressed_evidence_bytes"]:
        state["fatal_error"] = "compressed evidence bound reached"
        state["terminal"] = True
    state_data = lzma.compress(canonical(state), preset=6)
    prefix = f"checkpoints/{state['checkpoint_number']:06d}"
    manifest = {"study_id": state["study_id"], "checkpoint": state["checkpoint_number"],
                "code_sha": state["code_sha"], "protocol_sha256": state["protocol_sha256"],
                "previous_manifest_sha256": state.get("last_manifest_sha256"),
                "state_sha256": sha(state_data), "at": state["last_cycle_at"],
                "segment": state["segment"], "segment_complete": state["segment_complete"],
                "terminal": state["terminal"], "state_path": prefix + "/state.json.xz",
                "raw_path": prefix + "/raw.jsonl.xz", **raw_info}
    verify_raw(raw_data, manifest)
    files = {prefix + "/state.json.xz": state_data, prefix + "/raw.jsonl.xz": raw_data,
             prefix + "/manifest.json": canonical(manifest),
             "latest/state.json.xz": state_data, "latest/manifest.json": canonical(manifest),
             "summary.json": canonical(summary)}
    for name, content in files.items():
        p = directory / name
        p.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(p, content, immutable=name.startswith("checkpoints/"))
    return files, manifest


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect refused")


class Publisher:
    """GitHub token is used solely for the fixed research checkpoint branch."""
    def __init__(self, protocol, code_sha):
        self.p = protocol
        self.code_sha = code_sha
        self.token = os.environ.get("GH_TOKEN")
        if not self.token:
            raise RuntimeError("checkpoint publishing credential unavailable")
        self.base = "https://api.github.com/repos/" + protocol["repository"]
        self.branch = protocol["state_branch"]
        if not self.branch.startswith("research/pmus-five-wallet-state-"):
            raise ValueError("checkpoint branch outside dedicated research scope")
        self.folder = "paper-results/" + protocol["study_id"] + "/"
        self.head = None
        self.pending_commit = None
        self.last_published_fingerprint = None

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

    def load(self, expected_previous_segment, protocol_hash):
        ref = self.ref()
        if not ref:
            raise ValueError("required checkpoint branch missing; bootstrap replay forbidden")
        self.head = ref["object"]["sha"]
        manifest_bytes = self.content("latest/manifest.json")
        manifest = json.loads(manifest_bytes)
        data = self.content("latest/state.json.xz")
        if sha(data) != manifest["state_sha256"]:
            raise ValueError("checkpoint state hash mismatch")
        state = json.loads(lzma.decompress(data))
        if (state["study_id"] != self.p["study_id"] or state["code_sha"] != self.code_sha
                or state["protocol_sha256"] != protocol_hash
                or state["segment"] != expected_previous_segment or not state["segment_complete"]):
            raise ValueError("checkpoint identity, code, protocol, or segment mismatch; no rewind")
        if manifest["raw_final_hash"] != state["raw_hash"] or manifest["raw_end_seq"] != state["raw_seq"]:
            raise ValueError("checkpoint manifest/state raw chain mismatch")
        raw_data = self.content(manifest["raw_path"])
        if sha(raw_data) != manifest["raw_sha256"]:
            raise ValueError("checkpoint raw compressed-file hash mismatch")
        verify_raw(raw_data, manifest)
        state["last_manifest_sha256"] = sha(canonical(manifest))
        for account in state["accounts"].values():
            verify_account(account, self.p["starting_capital_usd"])
        return state

    def _finish_pending(self):
        pending = self.pending_commit
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
