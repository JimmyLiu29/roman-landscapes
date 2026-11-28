"""Bounded acquisition, deterministic physical-map build and local static serving."""
from pathlib import Path
import hashlib
import io
import json
import math
import shutil
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
from foundation import BOUNDS

WEB = ROOT / 'web'
DIST = ROOT / 'dist'
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



VECTORS = {'land': {'Polygon', 'MultiPolygon'}, 'rivers': {'LineString', 'MultiLineString'},
           'lakes': {'Polygon', 'MultiPolygon'}, 'ocean': {'Polygon', 'MultiPolygon'}, 'coast': {'LineString', 'MultiLineString'}}


def shell_sources():
    vendors = json.loads((ROOT / 'data/vendor-lock.json').read_bytes())
    for name, expected in vendors.items():
        assert digest(WEB / name) == expected, name
    names = json.loads((ROOT / 'data/shell-manifest.json').read_bytes())
    assert set(names) == {p.name for p in WEB.iterdir() if p.is_file()}
    return {**{name: WEB / name for name in [*names, *vendors]},
            'vendor-lock.json': ROOT / 'data/vendor-lock.json'}


def acquire():
    from inputs import main as acquire_inputs
    acquire_inputs(sys.argv[2:] if __name__ == "__main__" else [])


def worker_text(directory, sources):
    names = sorted(set(sources) | {'release.json'})
    hashes = [digest(sources['sw.js'] if name == 'sw.js' else directory / name) for name in names]
    version = hashlib.sha256(''.join(hashes).encode()).hexdigest()[:16]
    cached = ['/' + name for name in names if name not in ('sw.js', '_headers')]
    return sources['sw.js'].read_text().replace('__SHELL_VERSION__', version).replace('__SHELL_FILES__', json.dumps(cached))


def build():
    from inputs import acquire as locked_inputs
    from preprocess import build_pack

    sources = shell_sources()
    cache = ROOT / '.cache'
    cache.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache) as temp:
        candidate = Path(temp) / 'dist'
        build_pack(candidate, locked_inputs('all'))
        for name, source in sources.items():
            target = candidate / name
            target.parent.mkdir(exist_ok=True, parents=True)
            shutil.copyfile(source, target)
        (candidate / 'sw.js').write_text(worker_text(candidate, sources))
        verify(candidate)
        previous = Path(temp) / 'previous'
        if DIST.exists():
            DIST.rename(previous)
        try:
            candidate.rename(DIST)
        except OSError:
            if previous.exists():
                previous.rename(DIST)
            raise


def verify(directory=DIST):
    from atlas.model import ARCHIVES
    from atlas.fields import warnings
    from atlas.validate import verify_pack
    from pmtiles.reader import Reader
    from pmtiles.tile import TileType
    from shapely.geometry import box, shape
    from PIL import Image
    from render_docs import check

    release = json.loads((directory / 'release.json').read_bytes())
    assert release['bounds'] == BOUNDS and release['view_bounds'] == VIEW_BOUNDS
    assert release['tile_zoom'] == [0, 6] and release['view_zoom'] == [1, 7]
    assert release['scope'] == ['simple-base','natural-base','source-credits', *(d['id'] for d in release['datasets'])]
    archives = release['archives']
    assert len(archives) == len(ARCHIVES) and {a['id'] for a in archives} == set(ARCHIVES)
    for archive in archives:
        source = archive['id']
        _, count, notice = ARCHIVES[source]
        assert archive['record_count'] == count and archive['member_browse_mode'] == 'archive'
        assert archive['anchor_id'] == ('karanis:archive' if source == 'oxford-karanis' else None)
        assert archive['collection_notices'] == warnings([notice])
    receipt = verify_pack(directory)
    sources = shell_sources()
    expected = set(sources) | {'release.json'} | {f['path'] for f in release['files']}
    paths = {p.relative_to(directory).as_posix():p for p in directory.rglob('*') if p.is_file()}
    assert set(paths) == expected and len(paths) <= 20000
    assert max(p.stat().st_size for p in paths.values()) <= 25 * 1024**2
    for name, source in sources.items():
        if name != 'sw.js':
            assert digest(directory / name) == digest(source), name
    assert (directory / 'sw.js').read_text() == worker_text(directory, sources)
    pack = directory / 'packs' / release['id']
    manifest = json.loads((pack / 'sources.json').read_bytes())
    check(directory)
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
    print(json.dumps(dict(receipt, tiles=count, physical=counts, static_files=len(paths),
                          static_bytes=sum(p.stat().st_size for p in paths.values()), documents='verified')))


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
            overrides = {key: value for pattern, headers in rules.items() if fnmatchcase(path, pattern)
                         for key, value in headers.items()}
            for key, value in overrides.items():
                prefix = (key + ':').lower().encode()
                self._headers_buffer[:] = [line for line in self._headers_buffer if not line.lower().startswith(prefix)]
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
