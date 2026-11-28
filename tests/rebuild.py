"""Compare two macOS network-denied builds, optionally against a retained data release."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def write(path, data):
    path.write_text(json.dumps(data, indent=2, sort_keys=True)+'\n')


def compare(evidence, reference=None):
    evidence.mkdir(parents=True, exist_ok=True)
    previous = None
    for run in (1, 2):
        for command in ('build', 'verify'):
            with (evidence / f'offline-{run}-{command}.log').open('wb') as log:
                subprocess.run(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)',
                                ROOT/'bin'/command], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
        dist = ROOT / 'dist'
        hashes = {str(f.relative_to(dist)):hashlib.sha256(f.read_bytes()).hexdigest()
                  for f in sorted(dist.rglob('*')) if f.is_file()}
        write(evidence / f'offline-{run}-hashes.json', hashes)
        if previous is not None and hashes != previous:
            raise ValueError('Static file sets or digests differ between builds')
        previous = hashes
    release = json.loads((dist/'release.json').read_bytes())
    result = dict(release=release['id'], identicalFiles=len(hashes), network='macOS Seatbelt deny network*',
                  commands={'build':[0,0], 'verify':[0,0]})
    if reference:
        paths = ['release.json', *(f['path'] for f in release['files'])]
        for name in paths:
            if (dist/name).read_bytes() != (reference/name).read_bytes():
                raise ValueError('Reference content differs: '+name)
        result['frozenFiles'] = len(paths)
    write(evidence/'determinism.json', result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path)
    parser.add_argument('--reference', type=Path)
    args = parser.parse_args()
    compare(args.evidence, args.reference)
