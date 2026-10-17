#!/usr/bin/env python3
"""Verify a downloaded paper-results/<study_id> tree, including all raw chunks."""
import argparse
import json
import lzma
from pathlib import Path

from model import canonical, sha, verify_account
from persistence import verify_raw


def verify(folder):
    folder = Path(folder)
    previous_manifest = None
    previous_raw = "0" * 64
    previous_seq = 0
    count = 0
    for path in sorted((folder / "checkpoints").glob("*/manifest.json")):
        manifest = json.loads(path.read_bytes())
        if manifest["previous_manifest_sha256"] != previous_manifest or manifest["raw_previous_hash"] != previous_raw:
            raise ValueError("checkpoint manifest or raw-chain linkage mismatch")
        if manifest["raw_start_seq"] != previous_seq + 1:
            raise ValueError("raw sequence gap")
        data = (folder / manifest["raw_path"]).read_bytes()
        if sha(data) != manifest["raw_sha256"]:
            raise ValueError("compressed raw digest mismatch")
        verify_raw(data, manifest)
        state_data = (folder / manifest["state_path"]).read_bytes()
        if sha(state_data) != manifest["state_sha256"]:
            raise ValueError("compressed state digest mismatch")
        state = json.loads(lzma.decompress(state_data))
        if state["raw_hash"] != manifest["raw_final_hash"] or state["raw_seq"] != manifest["raw_end_seq"]:
            raise ValueError("raw/state mismatch")
        for account in state["accounts"].values():
            verify_account(account, "1000")
        previous_raw, previous_seq = manifest["raw_final_hash"], manifest["raw_end_seq"]
        previous_manifest = sha(canonical(manifest))
        count += 1
    if not count:
        raise ValueError("no completed published checkpoint")
    return {"checkpoints_verified": count, "raw_records": previous_seq,
            "last_manifest_sha256": previous_manifest, "last_raw_hash": previous_raw}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("folder")
    print(json.dumps(verify(p.parse_args().folder), indent=2))
