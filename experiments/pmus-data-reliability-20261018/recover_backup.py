"""Select the newest available same-run artifact; never reset its plan or WAL."""
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path


def recover(source, output, run_id, attempt, code_sha):
    if not re.fullmatch(r"[0-9]{6,20}", run_id) or not re.fullmatch(r"[a-f0-9]{40}", code_sha) or attempt < 1:
        raise ValueError("invalid_recovery_identity")
    pattern = re.compile(r"pmus-data-soak-" + re.escape(run_id) + "-" + str(attempt) + r"-soak_([0-9]{2})")
    choices = [(int(match[1]), path) for path in Path(source).iterdir()
               if (match := pattern.fullmatch(path.name)) and path.is_dir() and not path.is_symlink()]
    if not choices:
        raise ValueError("no_saved_segment_backup")
    _, chosen = max(choices)
    # A corrupt newest backup is an incident, not permission to rewind to an
    # earlier one. The collector verifies the complete hashes before appending.
    for name in ("events.jsonl", "plan.json", "publication.json"):
        if not (chosen / name).is_file() or (chosen / name).is_symlink():
            raise ValueError("incomplete_latest_segment_backup")
    for name in ("plan.json", "publication.json"):
        value = json.loads((chosen / name).read_bytes())
        if value["run_id"] != run_id or value["code_sha"] != code_sha:
            raise ValueError("recovery_backup_identity_mismatch")
    shutil.copytree(chosen, output)
    return chosen.name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt", type=int, required=True)
    parser.add_argument("--code-sha", required=True)
    args = parser.parse_args()
    if not args.source.exists():
        print("NO_LOCAL_BACKUP: collector must recover verified remote evidence or stop")
        return
    try:
        selected = recover(args.source, args.output, args.run_id, args.attempt, args.code_sha)
    except ValueError as exc:
        if str(exc) != "no_saved_segment_backup":
            raise
        print("NO_LOCAL_BACKUP: collector must recover verified remote evidence or stop")
        return
    print("RECOVERED_LOCAL_DATA_BACKUP=" + selected)


if __name__ == "__main__":
    main()
