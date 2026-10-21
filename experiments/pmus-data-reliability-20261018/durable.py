"""Crash-recoverable, market-data-only evidence. Does not load a trading ledger."""
from __future__ import annotations

import base64
import hashlib
import json
import lzma
import os
import tempfile
import threading
from pathlib import Path

from quality import canonical, digest
from probe import allowed, raw_body

ZERO = "0" * 64


def atomic_write(path, data, immutable=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if immutable and path.exists():
        if path.read_bytes() != data:
            raise ValueError("immutable_evidence_changed")
        return
    name = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
            name = Path(out.name)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        name = None
        descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if name is not None:
            name.unlink(missing_ok=True)


def decode_rows(data, previous=ZERO, seq=0):
    if data and not data.endswith(b"\n"):
        raise ValueError("partial_journal_tail_preserve_for_recovery")
    rows = []
    for line in data.splitlines():
        row = json.loads(line)
        claimed = row.pop("hash")
        if row["seq"] != seq + 1 or row["previous_hash"] != previous or digest(row) != claimed:
            raise ValueError("journal_linkage_mismatch")
        seq, previous = row["seq"], claimed
        rows.append({**row, "hash": claimed})
    return rows, seq, previous


def verify_checkpoints(root):
    root = Path(root)
    previous, seq, raw_hash, rows = None, 0, ZERO, []
    for number, folder in enumerate(sorted((root / "checkpoints").glob("[0-9]" * 6)), 1):
        if folder.name != f"{number:06d}":
            raise ValueError("checkpoint_number_gap")
        data = (folder / "manifest.json").read_bytes()
        manifest = json.loads(data)
        if manifest["previous_manifest_sha256"] != previous or manifest["first_seq"] != seq + 1:
            raise ValueError("checkpoint_manifest_linkage_mismatch")
        raw = (folder / "raw.jsonl.xz").read_bytes()
        summary = (folder / "summary.json").read_bytes()
        if hashlib.sha256(raw).hexdigest() != manifest["raw_sha256"] or hashlib.sha256(summary).hexdigest() != manifest["summary_sha256"]:
            raise ValueError("checkpoint_file_digest_mismatch")
        decoded, seq, raw_hash = decode_rows(lzma.decompress(raw), raw_hash, seq)
        if seq != manifest["end_seq"] or raw_hash != manifest["raw_final_hash"]:
            raise ValueError("checkpoint_raw_terminal_mismatch")
        rows.extend(decoded)
        previous = hashlib.sha256(data).hexdigest()
    return {"rows": rows, "seq": seq, "head": raw_hash, "manifest_sha256": previous,
            "checkpoints": number if previous else 0}


class DurableJournal:
    """Fsync every acknowledged row; sealing never closes the active journal."""
    def __init__(self, directory, resume=False, evidence_limit=1024 * 1024**2,
                 body_limit=512 * 1024**2):
        self.root = Path(directory)
        self.lock = threading.RLock()
        if resume:
            if not self.root.is_dir():
                raise ValueError("missing_recovery_directory")
        else:
            self.root.mkdir(parents=True, exist_ok=False)
        (self.root / "bodies").mkdir(exist_ok=True)
        self.path = self.root / "events.jsonl"
        raw = self.path.read_bytes() if self.path.exists() else b""
        self.rows, self.seq, self.head = decode_rows(raw)
        self.total, self.limit = len(raw), evidence_limit
        self.bodies = {}
        self.body_limit = body_limit
        self.body_total = sum(p.stat().st_size for p in (self.root / "bodies").glob("*.xz"))
        for row in self.rows:
            if row["kind"] == "http":
                h = row["payload"]
                raw_body(self.path, h)
                if h["method"] != "GET" or h["authenticated"] is not False or not allowed(h["url"]):
                    raise ValueError("unexpected_request_authority")
                self.bodies[h["body_sha256"]] = {k: h[k] for k in ("body_path", "compressed_bytes")}
        checked = verify_checkpoints(self.root)
        if checked["rows"] != self.rows[:checked["seq"]]:
            raise ValueError("checkpoint_differs_from_durable_journal")
        self.sealed_seq, self.checkpoint = checked["seq"], checked["checkpoints"]
        self.previous_manifest = checked["manifest_sha256"]
        self.stream_captures = {}
        for row in self.rows:
            if row["kind"] == "stream_book" and "receipt_evidence" in row["payload"]:
                payload = row["payload"]
                if payload["receipt_evidence"].get("seq", row["seq"]) >= row["seq"]:
                    raise ValueError("stream_capture_precedes_receipt")
                self._verify_stream_receipt(payload["market_data"], payload["received_at"], payload["receipt_evidence"])
                self.stream_captures[payload["receipt_evidence"]["seq"]] = {"seq": row["seq"], "hash": row["hash"]}
        self.writer = self.path.open("ab", buffering=0)
        self.closed = False

    def stream_receipt(self, market_data, received_at):
        """Hash every receipt; persist full books when selected for evaluation.

        Repeated full depth in every incoming message exhausted the 1 GiB WAL.
        Receipt hashes preserve arrival order and bind any subsequently captured
        decision book to the exact bytes already received before the decision.
        """
        return self.add("stream_book_receipt", {
            "received_at": received_at, "slug": market_data["marketSlug"],
            "book_at": market_data["transactTime"], "book_sha256": digest(market_data)})

    def _verify_stream_receipt(self, market_data, received_at, evidence):
        seq = evidence.get("seq")
        if type(seq) is not int or not 1 <= seq <= len(self.rows):
            raise ValueError("invalid_stream_receipt_reference")
        row = self.rows[seq - 1]
        if (row["hash"] != evidence.get("hash") or row["kind"] != "stream_book_receipt"
                or row["payload"]["received_at"] != received_at
                or row["payload"]["book_sha256"] != digest(market_data)):
            raise ValueError("stream_book_receipt_mismatch")

    def capture_stream_book(self, market_data, received_at, evidence):
        with self.lock:
            self._verify_stream_receipt(market_data, received_at, evidence)
            if evidence["seq"] not in self.stream_captures:
                self.stream_captures[evidence["seq"]] = self.add("stream_book", {
                    "market_data": market_data, "received_at": received_at,
                    "receipt_evidence": evidence})
            return self.stream_captures[evidence["seq"]]

    def add(self, kind, payload):
        with self.lock:
            if self.closed:
                raise ValueError("journal_already_closed")
            row = {"seq": self.seq + 1, "previous_hash": self.head,
                   "kind": kind, "payload": payload}
            row["hash"] = digest(row)
            line = canonical(row) + b"\n"
            if self.total + len(line) > self.limit:
                raise RuntimeError("evidence_limit_reached")
            # Acknowledgement occurs only after all bytes and fsync succeed.
            view = memoryview(line)
            while view:
                written = self.writer.write(view)
                if not written:
                    raise OSError("journal_short_write")
                view = view[written:]
            os.fsync(self.writer.fileno())
            self.rows.append(row)
            self.seq, self.head = row["seq"], row["hash"]
            self.total += len(line)
            return {"seq": self.seq, "hash": self.head}

    def http(self, record, data):
        with self.lock:
            sha = hashlib.sha256(data).hexdigest()
            if sha != record["body_sha256"] or len(data) != record["body_bytes"]:
                raise ValueError("http_body_digest_mismatch")
            if sha not in self.bodies:
                encoded = lzma.compress(data, preset=3)
                if self.body_total + len(encoded) > self.body_limit:
                    raise RuntimeError("compressed_body_evidence_limit_reached")
                name = "bodies/" + sha + ".xz"
                atomic_write(self.root / name, encoded, immutable=True)
                self.bodies[sha] = {"body_path": name, "compressed_bytes": len(encoded)}
                self.body_total += len(encoded)
            return self.add("http", {**record, **self.bodies[sha]})

    def seal(self, summary):
        with self.lock:
            if self.seq == self.sealed_seq:
                return self.checkpoint
            folder = self.root / "checkpoints" / f"{self.checkpoint + 1:06d}"
            raw = lzma.compress(b"".join(canonical(row) + b"\n" for row in self.rows[self.sealed_seq:]), preset=3)
            summary_data = canonical(summary) + b"\n"
            manifest = {"checkpoint": self.checkpoint + 1, "first_seq": self.sealed_seq + 1,
                        "end_seq": self.seq, "raw_final_hash": self.head,
                        "previous_manifest_sha256": self.previous_manifest,
                        "raw_sha256": hashlib.sha256(raw).hexdigest(),
                        "summary_sha256": hashlib.sha256(summary_data).hexdigest()}
            # A killed writer must not expose half a sealed checkpoint.
            folder.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=folder.parent, prefix=".sealing-") as temporary:
                staging = Path(temporary) / "complete"
                for name, data in (("raw.jsonl.xz", raw), ("summary.json", summary_data),
                                   ("manifest.json", canonical(manifest) + b"\n")):
                    atomic_write(staging / name, data, immutable=True)
                if folder.exists():
                    raise ValueError("immutable_checkpoint_already_exists")
                os.rename(staging, folder)
                descriptor = os.open(folder.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            atomic_write(self.root / "summary.json", summary_data)
            self.previous_manifest = hashlib.sha256(canonical(manifest) + b"\n").hexdigest()
            self.sealed_seq, self.checkpoint = self.seq, self.checkpoint + 1
            return self.checkpoint

    def close(self):
        with self.lock:
            if not self.closed:
                self.writer.close()
                self.closed = True


def restore_events(root):
    """Rebuild only an absent WAL from a verified published checkpoint chain."""
    root = Path(root)
    if (root / "events.jsonl").exists():
        raise ValueError("refusing_to_overwrite_local_journal")
    verified = verify_checkpoints(root)
    atomic_write(root / "events.jsonl", b"".join(canonical(r) + b"\n" for r in verified["rows"]), immutable=True)
    return verified
