#!/usr/bin/env python3
"""Verify published synthetic fixture bytes with the exact existing evaluator."""
import argparse
import hashlib
import json
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code-root', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--files', type=Path, required=True)
    parser.add_argument('--summary', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.code_root / 'experiments/pmus-four-wallet-unified-20261022'))
    import run
    from verify import verify
    summary = json.loads(args.summary.read_bytes())
    assert summary['synthetic_fixture_only'] is True
    assert summary['actual_paper_epoch_initialized'] is False
    assert summary['collector_bundle_sha256'] == run.bundle_digest()
    manifest = json.loads(args.files.read_bytes())
    expected = {row['path']: row for row in manifest}
    if len(expected) != len(manifest):
        raise ValueError('duplicate_manifest_path')
    for name in expected:
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('unsafe_manifest_path')
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        with tarfile.open(args.archive, 'r:xz') as archive:
            members = archive.getmembers()
            if len({m.name for m in members}) != len(members) or {m.name for m in members} != set(expected):
                raise ValueError('archive_manifest_path_mismatch')
            if sum(m.size for m in members) > 8 * 1024**2:
                raise ValueError('fixture_archive_size_bound')
            for member in members:
                if not member.isfile():
                    raise ValueError('archive_non_file')
                row = expected[member.name]
                if member.size != row['bytes']:
                    raise ValueError('archive_length_mismatch')
                data = archive.extractfile(member).read()
                if hashlib.sha256(data).hexdigest() != row['sha256']:
                    raise ValueError('archive_file_digest_mismatch')
                target = root / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        plan = json.loads((root / 'plan.json').read_bytes())
        assert plan['synthetic_fixture_only'] and not plan['actual_paper_start']
        assert plan['code_sha'] == summary['collector_code_commit']
        result = verify(root)
        if result != summary['final_verification']:
            raise ValueError('published_evaluator_summary_mismatch')
        print(json.dumps({'synthetic_fixture_only': True, 'internal_files_verified': len(expected),
                          'collector_code_commit': summary['collector_code_commit'],
                          'collector_bundle_sha256': summary['collector_bundle_sha256'],
                          'published_fixture_recomputed_equal': True,
                          'actual_paper_epoch_initialized': False,
                          'verification': result}, indent=2))


if __name__ == '__main__':
    main()
