"""Verify and publish the supported Koharu export, manifest and model card together."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = 'c0ffeeOverdose/arn-manga-models'
MIRROR_BASE_REVISION = 'faeda2dfb50ec66b1f28902c0d47f0a1ef15d1e8'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, default=ROOT / 'models/koharu-fp32-chunked.onnx')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    payload = ROOT / 'docs/model-mirror'
    manifest_path = payload / 'koharu-fp32-chunked.json'
    manifest = json.loads(manifest_path.read_text())
    if args.model.stat().st_size != manifest['bytes']:
        raise RuntimeError('Koharu model size differs from the supported artifact')
    with args.model.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != manifest['sha256']:
        raise RuntimeError('Koharu model checksum differs from the supported artifact')
    files = [(manifest['file'], args.model), (manifest_path.name, manifest_path),
             ('README.md', payload / 'README.md'),
             ('export_koharu_onnx.py', ROOT / 'scripts/export-koharu-onnx.py'),
             ('LICENSE-export', ROOT / 'LICENSE')]
    for destination, path in files:
        print(f'{destination}: {path.stat().st_size} bytes')
    print(f'Koharu SHA-256: {digest}')
    if args.dry_run:
        print(f'Verified payload for {REPO}; no upload performed.')
        return

    from huggingface_hub import CommitOperationAdd, HfApi
    api = HfApi()
    api.auth_check(repo_id=REPO, repo_type='model', write=True)
    if api.model_info(REPO).sha != MIRROR_BASE_REVISION:
        raise RuntimeError('Mirror changed. Review the current model card and update MIRROR_BASE_REVISION before publishing.')
    commit = api.create_commit(
        repo_id=REPO,
        parent_commit=MIRROR_BASE_REVISION,
        operations=[CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(path)) for name, path in files],
        commit_message='Add browser Koharu FP32 export with bounded attention and upstream terms',
    )
    print(commit.commit_url)


if __name__ == '__main__':
    main()
