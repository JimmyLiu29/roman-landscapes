"""Bounded acquisition, deterministic physical-map build and local static serving."""
from pathlib import Path
import hashlib
from collections import Counter, defaultdict
import io
import json
import math
import shutil
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
from foundation import BOUNDS, SOURCES, build_foundation, roma_distance_km

RAW = ROOT / 'data/raw'
WEB = ROOT / 'web'
DIST = ROOT / 'dist'
MANIFEST = ROOT / 'data/source-manifest.json'
VIEW_BOUNDS = [-27, 8, 65, 67]

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n', encoding='utf-8')


def physical_vectors(out, manifest):
    import shapefile
    from shapely.geometry import shape, mapping, box
    clip = box(*VIEW_BOUNDS)
    land_shapes = []
    for name in ['land', 'rivers', 'lakes']:
        record = next(r for r in manifest['sources'] if r['id'] == 'natural-earth-' + name)
        with zipfile.ZipFile(ROOT / record['path']) as archive:
            stem = next(n[:-4] for n in archive.namelist() if n.endswith('.shp'))
            reader = shapefile.Reader(shp=io.BytesIO(archive.read(stem + '.shp')),
                                      shx=io.BytesIO(archive.read(stem + '.shx')),
                                      dbf=io.BytesIO(archive.read(stem + '.dbf')), encoding='utf-8')
            features = []
            counts = {'input': 0, 'excluded_class': 0, 'outside': 0, 'empty': 0}
            for index, row in enumerate(reader.iterShapeRecords()):
                counts['input'] += 1
                attrs = row.record.as_dict()
                kind = attrs.get('featurecla')
                if not row.shape.points:
                    counts['empty'] += 1
                    continue
                geom = shape(row.shape.__geo_interface__)
                if not geom.intersects(clip):
                    counts['outside'] += 1
                    continue
                if kind in ['Canal', 'Reservoir']:
                    counts['excluded_class'] += 1
                    continue
                if not geom.is_valid:
                    from shapely import make_valid
                    geom = make_valid(geom)
                geom = geom.intersection(clip).simplify(0.006, preserve_topology=True)
                if geom.is_empty:
                    counts['empty'] += 1
                    continue
                if name == 'land': land_shapes.append(geom)
                features.append({'type': 'Feature', 'id': index,
                                 'properties': {'source_id': record['id'], 'class': kind,
                                                'name': attrs.get('name'), 'rank': attrs.get('scalerank')},
                                 'geometry': mapping(geom)})
            counts['output'] = len(features)
            assert counts['input'] == sum(counts[k] for k in ['excluded_class', 'outside', 'empty', 'output'])
            write_json(out / f'{name}.geojson', {'type': 'FeatureCollection', 'features': features})
            record['status'] = 'imported'
            record['accounting'] = counts
            record['display_simplification_degrees'] = 0.006
    from shapely.ops import unary_union
    land = unary_union(land_shapes)
    coast = land.boundary.difference(clip.exterior.buffer(1e-6))
    write_json(out / 'coast.geojson', {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {}, 'geometry': mapping(coast)}]})
    ocean = clip.difference(land)
    write_json(out / 'ocean.geojson', {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {}, 'geometry': mapping(ocean)}]})


def tile_range(z):
    n = 2 ** z
    def y(lat):
        return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return (range(int((VIEW_BOUNDS[0] + 180) / 360 * n), int((VIEW_BOUNDS[2] + 180) / 360 * n) + 1),
            range(y(VIEW_BOUNDS[3]), y(VIEW_BOUNDS[1]) + 1))


def relief_tiles(out, manifest):
    import numpy as np
    import rasterio
    from rasterio.vrt import WarpedVRT
    from rasterio.transform import from_bounds
    from rasterio.windows import Window
    from rasterio.enums import Resampling
    from PIL import Image
    from pmtiles.writer import Writer
    from pmtiles.tile import zxy_to_tileid, Compression, TileType
    record = next(r for r in manifest['sources'] if r['id'] == 'natural-earth-relief')
    cache = ROOT / '.cache/raster'
    cache.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(ROOT / record['path']) as archive:
        for suffix in ['.tif', '.tfw', '.prj']:
            member = next(n for n in archive.namelist() if n.lower().endswith(suffix))
            path = cache / Path(member).name
            path.write_bytes(archive.read(member))
    tiles = []
    for z in range(7):
        xs, ys = tile_range(z)
        tiles.extend((zxy_to_tileid(z, x, y), z, x, y) for x in xs for y in ys)
    tiles.sort()
    limit = 20037508.342789244
    with rasterio.open(cache / 'SR_LR.tif') as source:
        with WarpedVRT(source, src_crs='EPSG:4326', crs='EPSG:3857', width=16384, height=16384,
                       transform=from_bounds(-limit, -limit, limit, limit, 16384, 16384),
                       resampling=Resampling.bilinear) as vrt, (out / 'relief.pmtiles').open('wb') as stream:
            writer = Writer(stream)
            for tile_id, z, x, y in tiles:
                span = 16384 / 2 ** z
                data = vrt.read(window=Window(x * span, y * span, span, span),
                                out_shape=(source.count, 256, 256),
                                resampling=Resampling.average if z <= 3 else Resampling.bilinear)
                if source.count == 1:
                    data = np.repeat(data, 3, axis=0)
                image = Image.fromarray(np.moveaxis(data[:3], 0, -1))
                output = io.BytesIO()
                image.save(output, format='WEBP', quality=82, method=6)
                writer.write_tile(tile_id, output.getvalue())
            header = {'tile_compression': Compression.NONE, 'tile_type': TileType.WEBP,
                      'min_zoom': 0, 'max_zoom': 6,
                      'min_lon_e7': int(VIEW_BOUNDS[0] * 1e7), 'min_lat_e7': int(VIEW_BOUNDS[1] * 1e7),
                      'max_lon_e7': int(VIEW_BOUNDS[2] * 1e7), 'max_lat_e7': int(VIEW_BOUNDS[3] * 1e7),
                      'center_zoom': 3, 'center_lon_e7': int(18 * 1e7), 'center_lat_e7': int(40 * 1e7)}
            writer.finalize(header, {'name': 'Natural Earth shaded relief', 'attribution': 'Made with Natural Earth',
                                     'description': 'Modern physical reference geography; not reconstructed ancient terrain',
                                     'format': 'webp', 'bounds': ','.join(map(str, VIEW_BOUNDS)), 'minzoom': '0', 'maxzoom': '6'})
    record['status'] = 'imported'
    record['accounting'] = {'tiles': len(tiles), 'source_pixels': [16200, 8100], 'tile_pixels': 256}
    print(f'Generated {len(tiles)} relief tiles.')



SCOPE = ['simple-base', 'natural-base', 'source-credits', *SOURCES]
VECTORS = {'land': {'Polygon', 'MultiPolygon'}, 'rivers': {'LineString', 'MultiLineString'},
           'lakes': {'Polygon', 'MultiPolygon'}, 'ocean': {'Polygon', 'MultiPolygon'}, 'coast': {'LineString', 'MultiLineString'}}
PACK = {f'{layer}.geojson' for layer in VECTORS} | {'relief.pmtiles', 'sources.json'}
FOUNDATION_FILES = {'catalog.json.gz','relations.json.gz'} | {f'{k}.geojson.gz' for k in ('settlements','roads','ports','maritime')}
SHELL = {'layers.js', 'guide.js', 'foundation.js', 'search.js', 'details.js', '_headers', 'app.js', 'style.css', 'storage.js', 'index.html', 'sw.js', 'manifest.webmanifest',
         'icon-192.png', 'icon-512.png'}


def input_files(manifest):
    for source in manifest["sources"]:
        yield source
        yield from source.get("assets", [])


def acquire():
    from inputs import main as acquire_inputs
    acquire_inputs(sys.argv[2:] if __name__ == "__main__" else [])


def check_inputs():
    manifest = json.loads(MANIFEST.read_bytes())
    required = {
        'natural-earth-' + name for name in ['relief', 'land', 'rivers', 'lakes']} | set(SOURCES)
    assert required <= {r['id'] for r in manifest['sources']}
    manifest['sources'] = [r for r in manifest['sources'] if r['id'] in required]
    for record in input_files(manifest):
        assert digest(ROOT / record['path']) == record['sha256'], record['path']
    vendors = json.loads((ROOT / 'data/vendor-lock.json').read_bytes())
    for name, expected in vendors.items():
        assert digest(WEB / name) == expected, name
    return manifest, SHELL | set(vendors)


def build():
    manifest, shell = check_inputs()
    DIST.mkdir(exist_ok=True)
    # Recreate the dedicated output directory so stale releases cannot be deployed.
    shutil.rmtree(DIST)
    for name in sorted(shell):
        (DIST / name).parent.mkdir(exist_ok=True, parents=True)
        shutil.copyfile(WEB / name, DIST / name)
    stage = DIST / 'packs/stage'
    stage.mkdir(parents=True)
    physical_vectors(stage, manifest)
    relief_tiles(stage, manifest)
    build_foundation(stage, manifest)
    write_json(stage / 'sources.json', {'sources': [
        {k: v for k, v in record.items() if k != 'path'} for record in manifest['sources']]})
    hashes = {p.name: digest(p) for p in sorted(stage.iterdir())}
    version = 'foundation-' + hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()[:16]
    dest = stage.rename(stage.with_name(version))
    files = [{'path': f'packs/{version}/{name}', 'bytes': (dest / name).stat().st_size,
              'sha256': value, 'kind': 'archive' if name.endswith('.pmtiles') else 'gzip-json' if name.endswith('.gz') else 'json'}
             for name, value in hashes.items()]
    write_json(DIST / 'release.json', {'schema': 1, 'app_schema': 1, 'scope': SCOPE, 'id': version,
               'datasets': [{'id':r['id'], 'label':r['label']} for r in manifest['sources'] if r['id'] in SOURCES],
               'bounds': BOUNDS, 'tile_zoom': [0, 6], 'view_bounds': VIEW_BOUNDS, 'view_zoom': [1, 7],
               'files': files, 'bytes': sum(f['bytes'] for f in files)})
    cached = sorted((shell | {'release.json'}) - {'sw.js', '_headers'})
    # Response rules can change the bytes previously cached by browsers.
    versioned = sorted(shell | {'release.json'})
    identity = hashlib.sha256(''.join(digest(DIST / p) for p in versioned).encode()).hexdigest()[:16]
    worker = (WEB / 'sw.js').read_text(encoding='utf-8').replace('__SHELL_VERSION__', identity)
    (DIST / 'sw.js').write_text(worker.replace('__SHELL_FILES__', json.dumps(['/' + p for p in cached])), encoding='utf-8')
    verify()


def verify():
    from pmtiles.reader import Reader
    from pmtiles.tile import TileType
    from shapely.geometry import box, shape
    from PIL import Image

    manifest, shell = check_inputs()
    release = json.loads((DIST / 'release.json').read_bytes())
    assert release['scope'] == SCOPE and release['bounds'] == BOUNDS
    assert release['tile_zoom'] == [0, 6] and release['view_zoom'] == [1, 7] and release['view_bounds'] == VIEW_BOUNDS
    prefix = 'packs/' + release['id'] + '/'
    import gzip
    pack = DIST / prefix
    with gzip.open(pack / 'catalog.json.gz','rt') as file:
        catalog = json.load(file)['records']
    assert len(catalog) == len({r['id'] for r in catalog}) == 49711
    counts_by_source = Counter(r['source'] for r in catalog)
    assert counts_by_source == dict(zip(SOURCES, (1390, 14771, 885, 32665))), counts_by_source
    ids = {r['id'] for r in catalog}
    expected_ids = defaultdict(set)
    for row in catalog:
        expected_ids[row['detail']].add(row['id'])
    shards = set(expected_ids)
    def unpack(name):
        return json.loads(gzip.decompress((pack / name).read_bytes()))
    regional_names = 0
    for name, keys in expected_ids.items():
        entries = unpack(name)
        assert set(entries) == keys and all(detail['id'] == key for key, detail in entries.items()), name
        regional_names += sum(len(d.get('names', [])) for d in entries.values())
    assert regional_names == 29150
    nodes = [r for r in catalog if r['id'].startswith('orbis:place:')]
    assert len(nodes) == 301 and sum(r.get('layer') == 'ports' and 'bbox' in r for r in nodes) == 294
    assert sum('layer' not in r and 'bbox' not in r for r in nodes) == 7
    study = box(*BOUNDS)
    nearest_display = math.inf
    for layer, size in [('roads',14769), ('ports',294), ('maritime',584), ('settlements',1388)]:
        fc = unpack(layer+'.geojson.gz')
        assert fc['type'] == 'FeatureCollection' and len(fc['features']) == size
        layer_ids = {r['id'] for r in catalog if r.get('layer') == layer}
        assert {f['properties']['id'] for f in fc['features']} == layer_ids
        kinds = {'Point'} if layer in ('ports', 'settlements') else {'LineString', 'MultiLineString'}
        for feature in fc['features']:
            geometry = feature['geometry']
            geom = shape(geometry)
            assert feature['type'] == 'Feature' and geom.geom_type in kinds and geom.is_valid and not geom.is_empty
            assert study.covers(geom), feature['properties']['id']
            if layer == 'roads' and feature['properties']['certainty'] == 'Certain':
                coords = geometry['coordinates']
                lines = [coords] if geometry['type'] == 'LineString' else coords
                nearest_display = min(nearest_display, roma_distance_km(lines))
    assert nearest_display < 2, f'Exported roads are {nearest_display:.3f} km from Roma'
    edges = unpack('relations.json.gz')
    assert len(edges) == 1168 and all(e['from'] in ids and e['to'] in ids for e in edges)
    credits = {r['id']: r for r in json.loads((pack / 'sources.json').read_bytes())['sources']}
    assert credits['itinere']['accounting']['roma_vertex_km'] < 2
    package_files = PACK | FOUNDATION_FILES | shards
    expected = shell | {'release.json'} | {prefix + name for name in package_files}
    paths = {str(p.relative_to(DIST)): p for p in DIST.rglob('*') if p.is_file()}
    assert set(paths) == expected and len(paths) <= 20000
    assert max(p.stat().st_size for p in paths.values()) <= 25 * 1024 ** 2
    assert len(release['files']) == len(package_files)
    assert {f['path'] for f in release['files']} == {prefix + name for name in package_files}
    assert release['bytes'] == sum(f['bytes'] for f in release['files'])
    for item in release['files']:
        path = paths[item['path']]
        assert path.stat().st_size == item['bytes'] and digest(path) == item['sha256']
    for path in shell - {'sw.js'}:
        assert digest(DIST / path) == digest(WEB / path)
    pack = DIST / prefix
    clip = box(*VIEW_BOUNDS)
    counts = {}
    for name, kinds in VECTORS.items():
        collection = json.loads((pack / (name + '.geojson')).read_bytes())
        features = collection['features']
        assert collection['type'] == 'FeatureCollection' and features
        counts[name] = len(features)
        if name == 'coast':
            assert all(shape(f['geometry']).disjoint(clip.boundary) for f in features)
        if name not in ('ocean', 'coast'):
            record = next(r for r in manifest['sources'] if r['id'] == 'natural-earth-' + name)
            assert counts[name] == record['accounting']['output']
        for f in features:
            g = shape(f['geometry'])
            assert g.geom_type in kinds and g.is_valid and not g.is_empty and clip.covers(g), (name, f.get('id'))
            assert f['properties'].get('class') not in ('Canal', 'Reservoir')
    data = (pack / 'relief.pmtiles').read_bytes()
    reader = Reader(lambda offset, length: data[offset:offset + length])
    header = reader.header()
    assert header['tile_type'] == TileType.WEBP
    assert [header[k + '_e7'] / 1e7 for k in ('min_lon', 'min_lat', 'max_lon', 'max_lat')] == VIEW_BOUNDS
    assert (header['min_zoom'], header['max_zoom']) == (0, 6)
    count = 0
    for z in range(7):
        xs, ys = tile_range(z)
        for x in xs:
            for y in ys:
                with Image.open(io.BytesIO(reader.get(z, x, y))) as image:
                    assert image.format == 'WEBP' and image.size == (256, 256)
                    image.load()
                count += 1
    assert count == header['addressed_tiles_count'] == 394
    print(json.dumps({'release': release['id'], 'tiles': count, 'features': counts,
                      'catalog': dict(counts_by_source), 'shards': len(shards), 'relations': len(edges),
                      'regional_names': regional_names, 'ports': [294, 7], 'display_roma_vertex_km': nearest_display, 'roma_vertex_km': credits['itinere']['accounting']['roma_vertex_km'],
                      'static_files': len(paths), 'static_bytes': sum(p.stat().st_size for p in paths.values())}))


def serve():
    from functools import partial
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
    from fnmatch import fnmatchcase
    from urllib.parse import urlsplit
    import argparse

    rules = {}
    for line in (DIST / '_headers').read_text(encoding='utf-8').splitlines():
        if line.startswith('/'):
            headers = rules.setdefault(line, {})
        elif line.strip():
            key, value = line.strip().split(': ', 1)
            headers[key] = value

    class Handler(SimpleHTTPRequestHandler):
        def end_headers(self):
            path = urlsplit(self.path).path
            for pattern, headers in rules.items():
                if fnmatchcase(path, pattern):
                    for key, value in headers.items():
                        self.send_header(key, value)
            super().end_headers()

    parser = argparse.ArgumentParser()
    parser.add_argument('port', nargs='?', type=int, default=4173)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args(sys.argv[2:])
    server = ThreadingHTTPServer((args.host, args.port),
                                 partial(Handler, directory=DIST))
    server.serve_forever()


if __name__ == '__main__':
    {'acquire': acquire, 'build': build, 'verify': verify, 'serve': serve}[sys.argv[1]]()
