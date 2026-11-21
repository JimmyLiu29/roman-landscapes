"""Bounded acquisition, deterministic physical-map build and local static serving."""
from pathlib import Path
import hashlib
import io
import json
import math
import shutil
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data/raw'
WEB = ROOT / 'web'
DIST = ROOT / 'dist'
MANIFEST = ROOT / 'data/source-manifest.json'
BOUNDS = [-17, 15, 55, 63]
def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n')


def physical_vectors(out, manifest):
    import shapefile
    from shapely.geometry import shape, mapping, box
    clip = box(*BOUNDS)
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
                if kind in ['Canal', 'Reservoir']:
                    counts['excluded_class'] += 1
                    continue
                if not row.shape.points:
                    counts['empty'] += 1
                    continue
                geom = shape(row.shape.__geo_interface__)
                if not geom.intersects(clip):
                    counts['outside'] += 1
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
    ocean = clip.difference(unary_union(land_shapes))
    write_json(out / 'ocean.geojson', {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'properties': {}, 'geometry': mapping(ocean)}]})


def tile_range(z):
    n = 2 ** z
    def y(lat):
        return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return (range(int((BOUNDS[0] + 180) / 360 * n), int((BOUNDS[2] + 180) / 360 * n) + 1),
            range(y(BOUNDS[3]), y(BOUNDS[1]) + 1))


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
                                out_shape=(source.count, 256, 256), resampling=Resampling.bilinear)
                if source.count == 1:
                    data = np.repeat(data, 3, axis=0)
                image = Image.fromarray(np.moveaxis(data[:3], 0, -1))
                output = io.BytesIO()
                image.save(output, format='WEBP', quality=82, method=6)
                writer.write_tile(tile_id, output.getvalue())
            header = {'tile_compression': Compression.NONE, 'tile_type': TileType.WEBP,
                      'min_zoom': 0, 'max_zoom': 6,
                      'min_lon_e7': int(BOUNDS[0] * 1e7), 'min_lat_e7': int(BOUNDS[1] * 1e7),
                      'max_lon_e7': int(BOUNDS[2] * 1e7), 'max_lat_e7': int(BOUNDS[3] * 1e7),
                      'center_zoom': 3, 'center_lon_e7': int(18 * 1e7), 'center_lat_e7': int(40 * 1e7)}
            writer.finalize(header, {'name': 'Natural Earth shaded relief', 'attribution': 'Made with Natural Earth',
                                     'description': 'Modern physical reference geography; not reconstructed ancient terrain',
                                     'format': 'webp', 'bounds': ','.join(map(str, BOUNDS)), 'minzoom': '0', 'maxzoom': '6'})
    record['status'] = 'imported'
    record['accounting'] = {'tiles': len(tiles), 'source_pixels': [16200, 8100], 'tile_pixels': 256}
    print(f'Generated {len(tiles)} relief tiles.')



SCOPE = ['simple-base', 'natural-base', 'source-credits']
VECTORS = {'land': {'Polygon', 'MultiPolygon'}, 'rivers': {'LineString', 'MultiLineString'},
           'lakes': {'Polygon', 'MultiPolygon'}, 'ocean': {'Polygon', 'MultiPolygon'}}
PACK = {f'{layer}.geojson' for layer in VECTORS} | {'relief.pmtiles', 'sources.json'}
SHELL = {'_headers', 'app.js', 'style.css', 'storage.js', 'index.html', 'sw.js', 'manifest.webmanifest',
         'icon-192.png', 'icon-512.png'}


def acquire():
    """Restore the four locked public-domain inputs for a fresh checkout."""
    for record in json.loads(MANIFEST.read_bytes())['sources']:
        path = ROOT / record['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temp:
                candidate = Path(temp.name)
            try:
                with urllib.request.urlopen(record['url'], timeout=120) as src, candidate.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
                assert digest(candidate) == record['sha256'], 'Upstream snapshot differs from source lock'
                candidate.replace(path)
            finally:
                candidate.unlink(missing_ok=True)
        assert digest(path) == record['sha256'], 'Local input differs from source lock'


def check_inputs():
    manifest = json.loads(MANIFEST.read_bytes())
    assert {r['id'] for r in manifest['sources']} == {
        'natural-earth-' + name for name in ['relief', 'land', 'rivers', 'lakes']}
    for record in manifest['sources']:
        assert digest(ROOT / record['path']) == record['sha256'], record['id']
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
    write_json(stage / 'sources.json', {'sources': [
        {k: v for k, v in record.items() if k != 'path'} for record in manifest['sources']]})
    hashes = {p.name: digest(p) for p in sorted(stage.iterdir())}
    version = 'base-' + hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()[:16]
    dest = stage.rename(stage.with_name(version))
    files = [{'path': f'packs/{version}/{name}', 'bytes': (dest / name).stat().st_size,
              'sha256': value, 'kind': 'archive' if name.endswith('.pmtiles') else 'json'}
             for name, value in hashes.items()]
    write_json(DIST / 'release.json', {'schema': 1, 'app_schema': 1, 'scope': SCOPE, 'id': version,
               'bounds': BOUNDS, 'tile_zoom': [0, 6], 'view_zoom': [2, 7],
               'files': files, 'bytes': sum(f['bytes'] for f in files)})
    cached = sorted((shell | {'release.json'}) - {'sw.js', '_headers'})
    # Response rules can change the bytes previously cached by browsers.
    versioned = sorted(shell | {'release.json'})
    identity = hashlib.sha256(''.join(digest(DIST / p) for p in versioned).encode()).hexdigest()[:16]
    worker = (WEB / 'sw.js').read_text().replace('__SHELL_VERSION__', identity)
    (DIST / 'sw.js').write_text(worker.replace('__SHELL_FILES__', json.dumps(['/' + p for p in cached])))
    verify()


def verify():
    from pmtiles.reader import Reader
    from pmtiles.tile import TileType
    from shapely.geometry import box, shape
    from PIL import Image

    manifest, shell = check_inputs()
    release = json.loads((DIST / 'release.json').read_bytes())
    assert release['scope'] == SCOPE and release['bounds'] == BOUNDS
    assert release['tile_zoom'] == [0, 6] and release['view_zoom'] == [2, 7]
    prefix = 'packs/' + release['id'] + '/'
    expected = shell | {'release.json'} | {prefix + name for name in PACK}
    paths = {str(p.relative_to(DIST)): p for p in DIST.rglob('*') if p.is_file()}
    assert set(paths) == expected and len(paths) <= 20000
    assert max(p.stat().st_size for p in paths.values()) <= 25 * 1024 ** 2
    assert {f['path'] for f in release['files']} == {prefix + name for name in PACK}
    assert release['bytes'] == sum(f['bytes'] for f in release['files'])
    for item in release['files']:
        path = paths[item['path']]
        assert path.stat().st_size == item['bytes'] and digest(path) == item['sha256']
    for path in shell - {'sw.js'}:
        assert digest(DIST / path) == digest(WEB / path)
    pack = DIST / prefix
    clip = box(*BOUNDS)
    counts = {}
    for name, kinds in VECTORS.items():
        collection = json.loads((pack / (name + '.geojson')).read_bytes())
        features = collection['features']
        assert collection['type'] == 'FeatureCollection' and features
        counts[name] = len(features)
        if name != 'ocean':
            record = next(r for r in manifest['sources'] if r['id'] == 'natural-earth-' + name)
            assert counts[name] == record['accounting']['output']
        for f in features:
            g = shape(f['geometry'])
            assert g.geom_type in kinds and g.is_valid and not g.is_empty and clip.covers(g), (name, f.get('id'))
            assert f['properties'].get('class') not in ('Canal', 'Reservoir')
    data = (pack / 'relief.pmtiles').read_bytes()
    reader = Reader(lambda offset, length: data[offset:offset + length])
    header = reader.header()
    assert header['addressed_tiles_count'] == 258 and header['tile_type'] == TileType.WEBP
    assert [header[k + '_e7'] / 1e7 for k in ('min_lon', 'min_lat', 'max_lon', 'max_lat')] == BOUNDS
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
    assert count == 258
    print(json.dumps({'release': release['id'], 'tiles': count, 'features': counts,
                      'static_files': len(paths), 'static_bytes': sum(p.stat().st_size for p in paths.values())}))


def serve():
    from functools import partial
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
    server = ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2]) if len(sys.argv) > 2 else 4173),
                                 partial(SimpleHTTPRequestHandler, directory=DIST))
    server.serve_forever()


if __name__ == '__main__':
    {'acquire': acquire, 'build': build, 'verify': verify, 'serve': serve}[sys.argv[1]]()
