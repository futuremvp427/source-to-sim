"""Compressed evidence and checkpoints, published only to the dedicated study branch."""
from __future__ import annotations

import base64
import json
import lzma
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from model import canonical, sha, verify_account


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
        p.write_bytes(content)
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
        if self.branch != "research/pmus-four-wallet-state-20261018":
            raise ValueError("checkpoint branch outside dedicated research scope")
        self.folder = "paper-results/" + protocol["study_id"] + "/"
        self.head = None

    def request(self, path, method="GET", value=None, missing_ok=False):
        if not path.startswith(("/git/", "/contents/")):
            raise ValueError("GitHub checkpoint endpoint outside allowlist")
        request = urllib.request.Request(
            self.base + path, data=canonical(value) if value is not None else None,
            method=method, headers={"Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json", "User-Agent": "US-paper-checkpoints/1.0",
                "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json"})
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=35) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            if exc.code == 404 and missing_ok:
                return None
            raise RuntimeError(f"GitHub checkpoint request failed: HTTP {exc.code}") from None

    def ref(self):
        return self.request("/git/ref/heads/" + self.branch, missing_ok=True)

    def content(self, path):
        item = self.request("/contents/" + self.folder + path + "?ref=" + urllib.parse.quote(self.branch, safe=""))
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

    def publish(self, files, state, bootstrap=False):
        ref = self.ref()
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
        # A normal fast-forward can never overwrite a concurrent sibling commit.
        self.request("/git/refs/heads/" + self.branch, "PATCH", {"sha": new_commit["sha"], "force": False})
        self.head = new_commit["sha"]
        return self.head
