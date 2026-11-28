"""Build or verify a self-contained offline atlas from the locked inventory."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from atlas import economy, history, model
from atlas.fields import warnings
from foundation import BOUNDS, SOURCES, gzip_payload, cities, roads, maritime
from inputs import acquire
from pipeline import VIEW_BOUNDS, physical_vectors, relief_tiles


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()


def write(path, value):
    data = encoded(value)
    path.write_bytes(gzip_payload(data) if path.suffix == '.gz' else data)


def release_id(descriptor):
    return 'atlas-' + hashlib.sha256(encoded(descriptor)).hexdigest()[:16]


def public_metadata(value):
    if isinstance(value, list):
        return [public_metadata(v) for v in value]
    if isinstance(value, dict):
        return {k: public_metadata(v) for k, v in value.items() if k not in ('path', 'acquisition', 'acquisition_mode')}
    return value


def output_directory(path):
    out = Path(path).resolve()
    if out == ROOT or (out.is_relative_to(ROOT) and not out.is_relative_to(ROOT / '.cache')) or out in ROOT.parents:
        raise ValueError('Choose a dedicated output directory outside the product or under its cache.')
    return out


def build_pack(out, manifest, *, write_reports=False):
    sources = {r['id']: r for r in manifest['sources']}
    archive = model.Atlas(out, set(sources))
    stage = out / 'packs' / 'stage'
    stage.mkdir(parents=True)
    physical_vectors(stage, manifest)
    relief_tiles(stage, manifest)
    for name, adapter in zip(SOURCES[:3], (cities, roads, maritime)):
        adapter(archive, sources[name])
    model.gazetteer(archive, sources['pleiades'], model.required_places(sources))
    econ = economy.build_economy(archive, sources)
    hist = history.build_history(archive, sources)
    archive.normalize()

    for source, records in archive.details.items():
        for offset in range(0, len(records), 200):
            filename = f'details-{source}-{offset // 200:03d}.json.gz'
            batch = {d['id']: d for d in records[offset:offset+200]}
            write(stage / filename, batch)
            for key in batch:
                archive.index[key]['detail'] = filename
        codes = {w['code'] for d in records for w in d.get('warnings', [])}
        sources[source]['warnings'] = warnings(codes)
        sources[source]['accounting']['geometry_status'] = dict(Counter(d['geometry_status'] for d in records))
    for layer in model.LAYERS:
        write(stage / f'{layer}.geojson.gz', {'type': 'FeatureCollection',
              'features': sorted(archive.layers[layer], key=lambda f: f['id'])})
    write(stage / 'catalog.json.gz', {'schema': 2, 'records': archive.catalog})
    write(stage / 'relations.json.gz', archive.relations)
    for r in sources.values():
        r.setdefault('limitations', {
            'hanson-cities': ['Settlement and associated tables retain the native Primary Key.'],
            'orbis-maritime': ['Network routes describe modelled travel; seven endpoint nodes lack coordinates.'],
            'itinere': ['Road dates and alignments carry the uncertainty reported by the source.'],
            'pleiades': ['Representative points describe places at varying levels of precision.'],
            'oxford-mines': ['Some mining records lack a usable coordinate in the study area.'],
            'oxford-shipwrecks': ['Coordinates are approximate; some wrecks lack an in-bounds position.'],
            'oxford-karanis': ['The collection location cannot locate an individual tax transaction.'],
        }.get(r['id'], ['Modern physical reference geography; ancient terrain is not reconstructed.']))
    write(stage / 'sources.json', {'sources': public_metadata(manifest['sources'])})
    for path in stage.glob('*.geojson'):
        write(path, json.loads(path.read_bytes()))
    hist['event_position_basis'] = dict(Counter(
        d['occurrences']['events']['position_basis'] for d in archive.details[history.SOURCE] if 'events' in d['occurrences']))
    hist['occurrence_position_basis'] = dict(Counter(
        o['position_basis'] for d in archive.details[history.SOURCE] for o in d['occurrences'].values()))
    if write_reports:
        write(out / 'history-report.json', hist)
        write(out / 'economy-report.json', econ)
    files = []
    for path in sorted(stage.iterdir()):
        files.append(dict(name=path.name, bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                          kind='gzip-json' if path.suffix == '.gz' else 'archive' if path.suffix == '.pmtiles' else 'json'))
    datasets = [dict(id=k, label=sources[k]['label'], group='foundation' if k in SOURCES else
                     'history' if k == history.SOURCE else 'economy', archive_only=k in ('oxford-water','oxford-quarries'))
                for k in (*SOURCES, *economy.CATEGORIES, history.SOURCE)]
    archives = [dict(id=k, label=sources[k]['label'], category=economy.CATEGORIES[k], record_count=n,
                     member_browse_mode='archive', anchor_id='karanis:archive' if k == 'oxford-karanis' else None,
                     collection_notices=warnings([notice])) for k, (_, n, notice) in model.ARCHIVES.items()]
    descriptor = dict(schema=1, app_schema=2, scope=['simple-base','natural-base','source-credits', *(r['id'] for r in datasets)],
                      datasets=datasets, archives=archives, bounds=BOUNDS, view_bounds=VIEW_BOUNDS,
                      tile_zoom=[0,6], view_zoom=[1,7], files=files)
    version = release_id(descriptor)
    stage.rename(stage.with_name(version))
    write(out / 'release.json', {**descriptor, 'id': version, 'bytes': sum(f['bytes'] for f in files),
          'files': [{**{k:v for k,v in f.items() if k != 'name'}, 'path': f"packs/{version}/{f['name']}"} for f in files]})


def main():
    from atlas.validate import verify
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default=ROOT / '.cache/pack-v0.2', type=Path)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    out = output_directory(args.out)
    manifest = acquire('all')
    if args.verify_only:
        print(json.dumps(verify(out), sort_keys=True))
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as temp:
        candidate = Path(temp) / 'atlas'
        build_pack(candidate, manifest, write_reports=True)
        receipt = verify(candidate)
        if out.exists():
            if any(out.iterdir()):
                if verify(out) != receipt or any((candidate / f).read_bytes() != (out / f).read_bytes()
                        for f in ('release.json','history-report.json','economy-report.json')):
                    raise ValueError('The output directory contains a different atlas. Choose a fresh directory.')
            else:
                candidate.replace(out)
        else:
            candidate.rename(out)
    print(json.dumps(receipt, sort_keys=True))


if __name__ == '__main__':
    main()
