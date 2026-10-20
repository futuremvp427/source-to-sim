#!/usr/bin/env python3
"""Round-trip one labelled save-test row; zero venue or account requests."""
import argparse
import json
import time
from pathlib import Path

from durable import DurableJournal, atomic_write
from publication import GitMirror
from quality import canonical


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--code-sha", required=True)
    args = parser.parse_args(argv)
    args.output.mkdir(parents=True, exist_ok=False)
    evidence_id = args.run_id + "00"  # Distinct from the actual data soak.
    result = {"kind": "checkpoint_mirror_smoke", "passed": False,
              "workflow_run_id": args.run_id, "evidence_id": evidence_id,
              "code_sha": args.code_sha, "market_cycles": 0,
              "data_gate_passed": False, "strategy_result": False,
              "venue_or_account_requests": 0}
    journal = restored = None
    try:
        journal = DurableJournal(args.output / "original")
        plan = {"run_id": evidence_id, "code_sha": args.code_sha,
                "purpose": "save_path_test_only", "market_observations": 0,
                "started_at": time.time()}
        atomic_write(journal.root / "plan.json", canonical(plan) + b"\n", immutable=True)
        journal.add("save_path_test_only", {"workflow_run_id": args.run_id,
                    "code_sha": args.code_sha, "market_observations": 0})
        journal.seal(result)
        mirror = GitMirror(evidence_id, args.code_sha, journal.root)
        commit = mirror.sync(journal)
        copied = args.output / "restored"
        copied.mkdir(exist_ok=False)
        reader = GitMirror(evidence_id, args.code_sha, copied)
        if not reader.restore():
            raise ValueError("no_published_checkpoint_to_restore")
        restored = DurableJournal(copied, resume=True)
        if (restored.rows != journal.rows or restored.checkpoint != 1
                or reader.head != commit
                or (copied / "plan.json").read_bytes() != (journal.root / "plan.json").read_bytes()):
            raise ValueError("round_trip_identity_mismatch")
        result.update(passed=True, branch=mirror.branch, published_commit=commit,
                      raw_records=restored.seq, raw_hash=restored.head,
                      restored_checkpoint=restored.checkpoint)
    except Exception as exc:
        result["failure"] = type(exc).__name__
    finally:
        if restored is not None:
            restored.close()
        if journal is not None:
            journal.close()
        args.output.mkdir(parents=True, exist_ok=True)
        atomic_write(args.output / "result.json", canonical(result) + b"\n")
        print("PMUS_CHECKPOINT_MIRROR=" + json.dumps(result, sort_keys=True))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
