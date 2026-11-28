"""Validate the complete atlas using the Python standard library."""
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import re

from atlas.accounts import Accounts
from atlas.fields import WARNING_CATALOG
from atlas.model import ARCHIVES, GROUPS, LAYERS, RENDER_KINDS, bounds

COUNTS = dict(zip(('hanson-cities','itinere','orbis-maritime','pleiades','oxford-mines','oxford-shipwrecks',
                   'raad','oxford-karanis','oxford-presses','oxford-quarries','oxford-water','wikidata-history'),
                  (1390,14771,885,32666,1399,1819,2036,17054,232,792,647,1532)))
POINTS = dict(zip(LAYERS,(1388,14769,584,294,3277,324,414,944)))
PAYLOAD = {
    'hanson_settlement': 'geometry occurrences citations dates notes', 'hanson_bibliography': 'entries',
    'hanson_unmatched': 'notes', 'itinere_road': 'occurrences geometry native_geometry native_crs date_bounds date_margins dates source_feature_index notes',
    'itinere_bibliography': 'entries', 'itinere_fields': 'blocks', 'orbis_route': 'occurrences geometry notes',
    'orbis_place': 'notes', 'pleiades_place': 'reading names tables',
    'economy_mine': 'summary dates notes', 'economy_shipwreck': 'summary tables dates notes warnings',
    'economy_raad_assemblage': 'occurrences geometry summary dates notes warnings', 'economy_raad_type': 'notes',
    'economy_raad_observation': 'summary dates notes warnings geometry_note',
    'economy_karanis_archive': 'occurrences geometry archive_source crosswalk notes warnings',
    'economy_karanis_transaction': 'summary dates notes warnings geometry_note',
    'economy_press_group': 'summary dates notes warnings', 'economy_quarry': 'summary notes warnings',
    'economy_water_reference': 'summary dates notes warnings', 'economy_document_place': 'notes',
    'source_note': 'notes', 'history_event': 'occurrences geometry summary dates source_url history_selection history_links tables notes warnings',
    'history_person': 'occurrences geometry summary dates source_url history_selection history_links tables notes warnings',
}
STATUSES = {'mapped','selected_only','missing_coordinate','placeholder_zero','outside_map_bounds','no_representative_coordinate','archive_only'}
DATE_KEYS = set('key label display raw year precision calendar qualifiers sentinel basis statement_id'.split())


def read(path):
    data = path.read_bytes()
    return json.loads(gzip.decompress(data) if path.suffix == '.gz' else data)


def check_warnings(items):
    for w in items:
        assert w == {'code': w['code'], 'message': WARNING_CATALOG[w['code']]}


def check_dates(items):
    for item in items:
        assert set(item) == DATE_KEYS and isinstance(item['qualifiers'], list)
        assert item['calendar'] in (None,'Julian','Gregorian')
        assert item['year'] is None or type(item['year']) is int
        assert not item['sentinel'] or item['year'] is None
        assert not re.search(r'(?<!\d)(0|42339|9999) CE\b', item['display'])
        if item['year'] == 0:
            assert item['display'].startswith('0 (source value)')


def spatial(layer, geometry):
    t, coords = geometry['type'], geometry['coordinates']
    allowed = ('LineString','MultiLineString') if layer in ('maritime','roads') else (
        ('Point','MultiPoint') if layer in ('people','people-biography','events') else ('Point',))
    assert t in allowed and coords
    parts = coords if t == 'MultiLineString' else [[coords]] if t == 'Point' else [coords]
    for part in parts:
        assert part and (t not in ('LineString','MultiLineString') or len(set(map(tuple, part))) >= 2)
        for lon, lat in part:
            assert math.isfinite(lon) and -17 <= lon <= 55 and math.isfinite(lat) and 15 <= lat <= 63


def verify(out):
    assert {p.name for p in out.iterdir()} == {'release.json','economy-report.json','history-report.json','packs'}
    reports = {name: read(out/(name+'-report.json')) for name in ('economy','history')}
    return verify_pack(out, reports)


def verify_pack(out, reports=None):
    release = read(out/'release.json')
    v = release['id']
    assert re.fullmatch('atlas-[0-9a-f]{16}',v) and release['schema'] == 1 and release['app_schema'] == 2
    assert [p.name for p in (out/'packs').iterdir()] == [v]
    pack = out/'packs'/v
    files = []
    for p in sorted(pack.iterdir()):
        files.append({'name':p.name, 'bytes':p.stat().st_size, 'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
                      'kind':'gzip-json' if p.suffix == '.gz' else 'archive' if p.suffix == '.pmtiles' else 'json'})
    assert release['files'] == [{**{k:v for k,v in f.items() if k != 'name'}, 'path':f"packs/{v}/{f['name']}"} for f in files]
    desc = {k:r for k,r in release.items() if k not in ('id','bytes','files')}
    desc['files'] = files
    assert v == 'atlas-'+hashlib.sha256(json.dumps(desc, sort_keys=True,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode()).hexdigest()[:16]
    assert release['bytes'] == sum(f['bytes'] for f in files)
    sources = read(pack/'sources.json')['sources']
    assert len(sources) == len({s['id'] for s in sources}) == 16
    for s in sources:
        assert all(s[k] for k in ('citation','terms','terms_url','accounting','limitations'))
        check_warnings(s.get('warnings',[]))
    metadata = (pack/'sources.json').read_bytes().lower()
    assert all(term not in metadata for term in (b'"path":',b'"acquisition":',b'"acquisition_mode":'))
    datasets = release['datasets']
    assert len(datasets) == 12 and {r['id'] for r in datasets} == set(COUNTS)
    for r in datasets:
        assert r['archive_only'] == (r['id'] in ('oxford-water','oxford-quarries'))
    cat = read(pack/'catalog.json.gz')
    assert cat['schema'] == 2
    rows = cat['records']
    assert Counter(r['source'] for r in rows) == COUNTS
    assert rows == sorted(rows, key=lambda r:(r['source'],r['source_order'],r['id']))
    index = {r['id']:r for r in rows}
    assert len(index) == len(rows) == 75223
    assert {r['render_kind'] for r in rows} == RENDER_KINDS == set(PAYLOAD)
    features = {}
    for layer in LAYERS:
        collection = read(pack/(layer+'.geojson.gz'))
        assert collection['type'] == 'FeatureCollection' and len(collection['features']) == POINTS[layer]
        for f in collection['features']:
            props = f['properties']
            key = props['record_id']
            assert f['id'] == props['occurrence_id'] == key+'#'+layer and 'id' not in props
            assert key in index and f['id'] not in features and layer in index[key]['layers']
            assert all(props[k] == value for k,value in index[key].items() if k in ('source','label','kind','category'))
            spatial(layer, f['geometry'])
            features[f['id']] = f['geometry']
    shards = defaultdict(set)
    ranks = Counter()
    archives = Counter()
    for r in rows:
        source = r['source']
        rank = ranks[source]
        name = f'details-{source}-{rank//200:03d}.json.gz'
        ranks[source] += 1
        assert type(r['source_order']) is int and r['source_order'] == ranks[source] and r['detail'] == name
        assert 'layer' not in r and isinstance(r['layers'], list) and all(r[k] for k in ('id','label','kind'))
        if source not in ('hanson-cities','itinere','pleiades','orbis-maritime'):
            assert r['category']
        if r.get('archive'):
            assert ARCHIVES[source][0] == r['render_kind'] and r['archive'] == source
            archives[source] += 1
        shards[name].add(r['id'])
    base_files = {'relief.pmtiles','sources.json','catalog.json.gz','relations.json.gz'}
    base_files.update(name+'.geojson' for name in ('land','rivers','lakes','coast','ocean'))
    base_files.update(layer+'.geojson.gz' for layer in LAYERS)
    assert {p.name for p in pack.iterdir()} == base_files | set(shards)
    header = (pack/'relief.pmtiles').read_bytes()[:127]
    assert header[:8] == b'PMTiles\x03' and int.from_bytes(header[72:80], 'little') == 394
    assert list(header[100:102]) == [0,6] and release['view_bounds'] == [-27,8,65,67]
    for name, count in [('land',9),('rivers',318),('lakes',230),('coast',1),('ocean',1)]:
        vectors = read(pack/(name+'.geojson'))['features']
        assert len(vectors) == count and all(f['properties'].get('class') not in ('Canal','Reservoir') for f in vectors)
        if name == 'coast':
            geom = vectors[0]['geometry']
            lines = geom['coordinates'] if geom['type'] == 'MultiLineString' else [geom['coordinates']]
            assert all(-27 < x < 65 and 8 < y < 67 for line in lines for x,y in line)
    assert archives == {k:v[1] for k,v in ARCHIVES.items()}
    statuses, positions, notices = defaultdict(Counter), Counter(), Counter()
    accounts = Accounts()
    for name, ids in shards.items():
        batch = read(pack/name)
        assert set(batch) == ids and len(ids) <= 200
        for key, d in batch.items():
            r = index[key]
            kind = r['render_kind']
            assert d['id'] == key and d['render_kind'] == kind and 'native' in d
            assert set(PAYLOAD[kind].split()) <= d.keys(), (key, kind)
            assert 'position_basis' not in d and 'history_geometries' not in d
            status = d['geometry_status']
            statuses[r['source']][status] += 1
            assert status in STATUSES and (status == 'mapped') == bool(r['layers'])
            assert ('occurrences' in d) == bool(r['layers']) and ('geometry' in d) == (status in ('mapped','selected_only'))
            if status in ('placeholder_zero','missing_coordinate','outside_map_bounds','no_representative_coordinate'):
                assert d['geometry_note']
            assert set(d.get('occurrences',{})) == set(r['layers'])
            if r['layers']:
                assert d['geometry'] == d['occurrences'][r['layers'][0]]['geometry']
                boxes = {}
                for layer, occ in d['occurrences'].items():
                    assert features.pop(key+'#'+layer) == occ['geometry']
                    boxes[layer] = bounds(occ['geometry'])
                    positions[occ['position_basis']] += 1
                assert r['bbox'] == [fn(b[i] for b in boxes.values()) for i,fn in enumerate((min,min,max,max))]
                if len(boxes)>1:
                    assert r['layer_bboxes'] == boxes and r['layers'] == ['people','people-biography']
            check_warnings(d.get('warnings', []))
            notices.update(w['code'] for w in d.get('warnings', []))
            accounts.inspect(r, d)
            check_dates(d.get('dates', []))
            for e in d.get('dated_supporting_events', []):
                check_dates(e['dates'])
    accounts.finish(reports, sources)
    assert not features and notices['water_lost_greek']==622 and notices['shipwrecks_approximate_coords']==1818
    edges = read(pack/'relations.json.gz')
    assert edges == sorted(edges,key=lambda e:(GROUPS.index(e['group']),e['from'],e['role'],e['to'],e['basis']))
    for e in edges:
        assert set(e) == {'from','to','group','role','basis','source'} and e['basis']
        assert e['to'] in index and index[e['from']]['source'] == e['source']
    groups = Counter(e['group'] for e in edges)
    assert tuple(groups[g] for g in GROUPS) == (1168,71,1469,1469,197,622,387,812,2044,613,17053)
    assert set(groups) == set(GROUPS)
    assert [groups[g] for g in ('maritime_endpoint','economic_place','findspot_assemblage','amphora_type','event_town','archive_member')] == [1168,71,1469,1469,387,17053]
    assert groups['person_activity_town'] + groups['person_biography_town'] == 2856
    return dict(release=v, files=len(files), shards=len(shards), bytes=release['bytes'], max_file_bytes=max(f['bytes'] for f in files),
                catalog=dict(ranks), layers=POINTS, geometry_status=dict(statuses), relations=groups, position_basis=positions)
