"""Validate the source inventory and restore available remote inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
FOUNDATION = {'hanson-cities', 'itinere', 'orbis-maritime', 'pleiades',
              *('natural-earth-' + name for name in ('land', 'rivers', 'lakes', 'relief'))}
ADDITIONS = {'oxford-mines', 'oxford-shipwrecks', 'oxford-karanis', 'raad',
             'oxford-presses', 'oxford-quarries', 'oxford-water', 'wikidata-history'}


def matches(path, record):
    if not path.is_file() or path.stat().st_size != record['bytes']:
        return False
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() == record['sha256']


def acquire(scope, *, root=ROOT, download=False):
    manifest = json.loads((root / 'data/source-manifest.json').read_bytes())
    required = FOUNDATION if scope == 'foundation' else FOUNDATION | ADDITIONS
    sources = [r for r in manifest['sources'] if r['id'] in required]
    if {r['id'] for r in sources} != required or len(sources) != len(required):
        raise ValueError('Incomplete or duplicate source inventory')
    if scope == 'all' and len(manifest['sources']) != len(sources):
        raise ValueError('Unexpected source in inventory')
    missing, errors = [], []
    for source in sources:
        for record in (source, *source.get('assets', [])):
            path = root / record['path']
            mode = record.get('acquisition_mode', 'remote_url')
            if mode not in {'remote_url', 'pinned_local_snapshot', 'tracked_in_repo'}:
                raise ValueError(f'Unknown acquisition mode: {mode}')
            if matches(path, record):
                continue
            if download and mode == 'remote_url' and not path.exists():
                missing.append((path, record))
            else:
                errors.append(f"Restore {record['path']} (SHA-256 {record['sha256']}) from the locked source: {source['landing_url']}")
    if errors:
        raise ValueError('\n'.join(errors))
    for path, record in missing:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            candidate = Path(stream.name)
        try:
            with urllib.request.urlopen(record['url'], timeout=120) as src, candidate.open('wb') as dst:
                shutil.copyfileobj(src, dst)
            if not matches(candidate, record):
                raise ValueError(f"Upstream input differs from lock: {record['path']}")
            candidate.replace(path)
        finally:
            candidate.unlink(missing_ok=True)
    return {'schema': manifest['schema'], 'sources': sources}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scope', choices=('foundation', 'all'), default='all')
    try:
        result = acquire(parser.parse_args(argv).scope, download=True)
    except ValueError as exc:
        parser.exit(1, str(exc) + '\n')
    print(f"Verified {len(result['sources'])} sources and their companion files.")


if __name__ == '__main__':
    main()
