"""Source-qualified foundation adapters. No inferred historical identity joins."""
import csv
import gzip
import json
from collections import Counter, defaultdict
from pathlib import Path

from formats import xlsx_sheets, table_rows
from readings import city_references, bibliography_entries, field_document, plain_fields

ROOT = Path(__file__).resolve().parent.parent
BOUNDS = [-17, 15, 55, 63]
SOURCES = ('hanson-cities', 'itinere', 'orbis-maritime', 'pleiades')


def workbook(path):
    return {name: table_rows(rows) for name, rows in xlsx_sheets(path).items()}


def encoded(data):
    return (json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def output(path, data):
    payload = encoded(data)
    path.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0) if path.suffix == '.gz' else payload)


def read_csv(path):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def topo_lines(topology):
    """Decode delta positions, reversed arcs and joined endpoints per TopoJSON spec."""
    transform = topology.get('transform')
    arcs = []
    for arc in topology['arcs']:
        if transform:
            x = y = 0; points = []
            for delta in arc:
                x += delta[0]; y += delta[1]
                points.append([x * transform['scale'][0] + transform['translate'][0],
                               y * transform['scale'][1] + transform['translate'][1]])
        else: points = [list(p) for p in arc]
        arcs.append(points)
    def line(indices):
        points = []
        for index in indices:
            arc = arcs[index] if index >= 0 else list(reversed(arcs[~index]))
            if points:
                assert points[-1] == arc[0], 'Disconnected TopoJSON arc boundary'
                points.extend(arc[1:])
            else: points.extend(arc)
        assert len(points) >= 2
        return points
    for item in topology['objects']['base_routes']['geometries']:
        assert item['type'] in ['LineString', 'MultiLineString']
        coordinates = line(item['arcs']) if item['type'] == 'LineString' else [line(part) for part in item['arcs']]
        yield item, {'type': item['type'], 'coordinates': coordinates}


def inside(point):
    return BOUNDS[0] <= point[0] <= BOUNDS[2] and BOUNDS[1] <= point[1] <= BOUNDS[3]


def display_geometry(geometry, tolerance=0):
    from shapely.geometry import shape, mapping
    shape_ = shape(geometry)
    assert not shape_.is_empty and shape_.is_valid
    bbox = list(shape_.bounds)
    assert inside(bbox[:2]) and inside(bbox[2:]), f'Foundation geometry outside physical coverage: {bbox}'
    simple = mapping(shape_.simplify(tolerance, preserve_topology=True))
    def rounded(value):
        if isinstance(value, (list, tuple)): return [rounded(n) for n in value]
        return round(value, 6)
    compact = {'type': simple['type'], 'coordinates': rounded(simple['coordinates'])}
    # Preserve short parts and avoid introducing intersections into a simple source line.
    rounded_shape = shape(compact)
    if rounded_shape.is_valid and (not shape_.is_simple or rounded_shape.is_simple):
        return compact, bbox
    if not shape_.is_simple or shape(simple).is_simple:
        return simple, bbox
    return geometry, bbox


class Package:
    def __init__(self, stage, allowed_sources):
        self.stage = stage
        self.allowed_sources = allowed_sources
        self.catalog = []
        self.details = defaultdict(list)
        self.layers = defaultdict(list)
        self.relations = []
        self.ids = set()

    def add(self, id_, label, source, kind, native, geometry=None, aliases=None, layer=None, notes=None, related=None, tolerance=0, map_fields=None):
        assert source in self.allowed_sources, 'Excluded source cannot enter the runtime package'
        assert id_ not in self.ids, f'Duplicate identity: {id_}'
        self.ids.add(id_)
        index = {'id': id_, 'label': label, 'source': source, 'kind': kind}
        if layer: index['layer'] = layer
        if aliases: index['aliases'] = sorted(set(v for v in aliases if v and v != label))
        if geometry:
            simple, bbox = display_geometry(geometry, tolerance)
            index['bbox'] = bbox
            if layer:
                self.layers[layer].append({'type': 'Feature', 'id': id_,
                    'properties': {'id': id_, 'label': label, 'source': source, 'kind': kind, **(map_fields or {})}, 'geometry': simple})
        detail = {'id': id_, 'native': native}
        if geometry: detail['geometry'] = geometry
        if notes: detail['notes'] = notes
        if related: detail['tables'] = related
        self.catalog.append(index)
        self.details[source].append(detail)
        return index, detail

    def relation(self, start, end, role, basis, source=None):
        edge = {'from': start, 'to': end, 'role': role, 'basis': basis}
        if source: edge['source'] = source
        self.relations.append(edge)

    def finish(self):
        lookup = {r['id']: r for r in self.catalog}
        for source, records in self.details.items():
            records.sort(key=lambda r: r['id'])
            for start in range(0, len(records), 200):
                name = f'details-{source}-{start // 200:03}.json.gz'
                batch = records[start:start + 200]
                output(self.stage / name, {r['id']: r for r in batch})
                for r in batch: lookup[r['id']]['detail'] = name
        for rel in self.relations:
            assert rel['from'] in lookup and rel['to'] in lookup
        for name in sorted(set(['settlements', 'roads', 'maritime', 'ports']) | self.layers.keys()):
            output(self.stage / f'{name}.geojson.gz', {'type': 'FeatureCollection', 'features': self.layers[name]})
        output(self.stage / 'catalog.json.gz', {'schema': 1, 'records': sorted(self.catalog, key=lambda r: r['id'])})
        output(self.stage / 'relations.json.gz', self.relations)


def cities(package, record):
    tables = workbook(ROOT / record['path'])
    refs, resolve = city_references(tables['Bibliography'])
    native_ids = {r['Primary Key'] for r in tables['Cities']}
    joins = defaultdict(lambda: defaultdict(list)); orphans = []
    for name in ['Areas', 'Monuments', 'Civic Status']:
        for row in tables[name]:
            if row['Primary Key'] in native_ids: joins[row['Primary Key']][name].append(row)
            else: orphans.append({'table': name, **row})
    for row in tables['Cities']:
        id_ = 'hanson:' + row['Primary Key']
        geometry = {'type': 'Point', 'coordinates': [float(row['Longitude (X)']), float(row['Latitude (Y)'])]}
        _, detail = package.add(id_, row['Ancient Toponym'], 'hanson-cities', 'Settlement', row, geometry,
                    aliases=[row['Modern Toponym']], layer='settlements', map_fields={'rank': row['Barrington Atlas Rank']}, related=dict(joins[row['Primary Key']]),
                    notes=['Native table joins use Primary Key. No supplied Pleiades or ORBIS identity crosswalk. NULL dates remain unknown.',
                           'Areas, civic status and monuments retain source rows, including repeated entries.'])
        detail['citations'] = [resolve(token.strip().rstrip('.')) for token in row['Select Bibliography'].split(';') if token.strip().rstrip('.')]
        if row['Barrington Atlas Reference'] not in ('', '-'):
            detail['atlas_reference'] = {**resolve('BA'), 'grid': row['Barrington Atlas Reference']}
    _, bib = package.add('hanson:bibliography', 'Hanson Cities — bibliography', 'hanson-cities', 'Bibliography', tables['Bibliography'])
    bib['entries'] = refs
    package.add('hanson:unmatched', 'Hanson Cities — unmatched source rows', 'hanson-cities', 'Source note', orphans,
                notes=['The incomplete native key is retained without assigning the monument to a city.'])
    record['accounting'] = {name: len(rows) for name, rows in tables.items()}
    record['accounting'].update({'unmatched_related_rows': len(orphans), 'mapped_settlements': len(tables['Cities'])})
    record['status'] = 'imported'


def maritime(package, record):
    base = (ROOT / record['path']).parent
    topology = json.loads((ROOT / record['path']).read_text())
    sites = {r['id']: r for r in read_csv(base / 'o_sites.csv')}
    routes = [(native, geometry) for native, geometry in topo_lines(topology)
              if native['properties']['t'] in ['coastal', 'overseas', 'slowover', 'ferry']]
    # Official orbis.js resolves six-digit mode nodes to their final five digits.
    endpoint = lambda value: str(value)[1:] if len(str(value)) == 6 else str(value)
    used = {endpoint(native['properties'][field]) for native, _ in routes for field in ['sid', 'tid']}
    missing = sorted(used - sites.keys())
    for id_ in sorted(used):
        row = sites.get(id_)
        package.add('orbis:place:' + id_, row['label'] if row else 'Unresolved ORBIS node ' + id_, 'orbis-maritime',
                    'Network place' if row else 'Unresolved network place', row or {'id': id_},
                    {'type': 'Point', 'coordinates': [float(row['x']), float(row['y'])]} if row else None,
                    layer='ports', notes=['ORBIS native network identity; no cross-source identity inferred.'] if row else
                    ['Referenced by route geometry but absent from the retained node table. No name or coordinate has been inferred.'])
    for native, geometry in routes:
        attrs = native['properties']; start, end = endpoint(attrs['sid']), endpoint(attrs['tid'])
        title = f'{sites.get(start, {}).get("label", start)} → {sites.get(end, {}).get("label", end)} · {attrs["t"]}'
        id_ = 'orbis:route:' + str(attrs['gid'])
        package.add(id_, title, 'orbis-maritime', 'Maritime route', attrs, geometry, layer='maritime', map_fields={'t': attrs['t']},
                    notes=['Research transport-model geometry, not observed trade volume. Original sid/tid mode nodes are retained.',
                           'Includes coastal, overseas, slowover and ferry modes; parallel fast/slow routes remain separate.'], tolerance=0.0005)
        package.relation(id_, 'orbis:place:' + start, 'source-endpoint', 'ORBIS sid; upstream six-digit mode-prefix rule')
        package.relation(id_, 'orbis:place:' + end, 'target-endpoint', 'ORBIS tid; upstream six-digit mode-prefix rule')
    types = Counter(r['properties']['t'] for r in topology['objects']['base_routes']['geometries'])
    record['accounting'] = {'input_routes': sum(types.values()), 'native_types': dict(types), 'maritime_routes': len(routes),
        'excluded_other_modes': sum(types[k] for k in ['road', 'hires', 'upstream']), 'input_nodes': len(sites),
        'referenced_nodes': len(used), 'resolved_nodes': len(used) - len(missing), 'unresolved_node_ids': missing}
    record['endpoint_rule'] = 'orbis.js lines 206–207, retained upstream revision: strip first character only for six-digit sid/tid.'
    record['status'] = 'imported'


def gazetteer(package, record):
    base = (ROOT / record['path']).parent
    places = read_csv(ROOT / record['path']); names = read_csv(base / 'pleiades-v4.1-names.csv')
    groups = defaultdict(list)
    for ordinal, row in enumerate(names, 2):
        groups[row['place_id']].append((ordinal, row))
    counts = Counter(input_places=len(places), input_names=len(names))
    for row in places:
        if not row['representative_longitude'] or not row['representative_latitude']:
            counts['no_representative_coordinate'] += 1
            continue
        point = [float(row['representative_longitude']), float(row['representative_latitude'])]
        if not inside(point):
            counts['outside'] += 1
            continue
        pairs = groups[row['id']]
        related = [name for _,name in pairs]
        aliases = [name[k] for name in related for k in ('title','attested_form','romanized_form_1','romanized_form_2','romanized_form_3')]
        _, detail = package.add('pleiades:' + row['id'], row['title'], 'pleiades', 'Gazetteer place', row,
                                {'type':'Point','coordinates':point}, aliases=aliases, related={'Names': related})
        detail['reading'] = plain_fields(row)
        detail['names'] = [{'key': f"{name['place_id']}/{name['id']}/{ordinal}", 'source_row': ordinal,
                            'fields': plain_fields(name)} for ordinal,name in pairs]
        counts['regional_places'] += 1
        counts['regional_names'] += len(related)
    record['accounting'] = dict(counts)
    record['status'] = 'imported'


def roads(package, record):
    from rasterio.warp import transform_geom
    document = json.loads((ROOT / record['path']).read_text())
    assert document['crs']['properties']['name'].endswith('3395'), 'Inspect changed source CRS before transforming'
    seen = set(); certainty = Counter(); missing = Counter(); connectors = []
    for number, feature in enumerate(document['features']):
        attrs = feature['properties']; native_id = str(attrs['InLine_FID'])
        assert native_id not in seen, 'Inspect non-unique native road IDs'
        seen.add(native_id)
        geometry = transform_geom('EPSG:3395', 'EPSG:4326', feature['geometry'])
        # Display uses horizontal coordinates; the source XYZ geometry is retained below.
        geometry = {'type': geometry['type'], 'coordinates': [[[p[0], p[1]] for p in line] for line in geometry['coordinates']]}
        connector = attrs.get('Descriptio') == 'temporary' and 'ferry' in (attrs.get('Name') or '').lower()
        if connector: connectors.append(native_id)
        _, detail = package.add('itinere:17122148:' + native_id, attrs.get('Name') or 'Unnamed road ' + native_id,
            'itinere', 'Source ferry connector' if connector else 'Road segment', attrs, geometry, aliases=[native_id], layer='roads', tolerance=0.001,
            map_fields={'certainty':attrs['Segment_s'], 'ferry':bool(connector)},
            notes=['Frozen 2024 geometry, release v1.3. This export has no Pleiades proximity field or endpoint IDs.',
                   'Source Segment_s uncertainty and native date sentinels remain unchanged; no inferred city attachment.'])
        display = package.layers['roads'][-1]
        detail['geometry'] = display['geometry']
        detail['native_geometry'] = feature['geometry']; detail['native_crs'] = document['crs']
        detail['date_bounds'] = {key: None if attrs[key] in [0, 9999, None] else attrs[key] for key in ['Lower_Date', 'Upper_Date']}
        detail['date_margins'] = {key: None if attrs[key] in (0,9999,None) else attrs[key] for key in ('Low_Date_E','Up_Date_E')}
        detail['notes'].append('Date values 0 and 9999 mean missing data; they are not historical years. Display geometry is simplified; the full native XYZ geometry is included in the record export.')
        if connector: detail['notes'].append('This temporary ferry connector is explicitly supplied by the road-network source; it is not an independently evidenced road.')
        detail['source_feature_index'] = number
        certainty[str(attrs.get('Segment_s'))] += 1
        for key in ['Bibliograp', 'Citation']:
            if not attrs.get(key): missing[key] += 1
    record['accounting'] = {'input': len(document['features']), 'output': len(seen), 'certainty': dict(certainty),
                            'missing_fields': dict(missing), 'source_temporary_ferry_ids': connectors}
    record['display_simplification_degrees'] = 0.001
    record['status'] = 'imported'
    for asset in record['assets']:
        if asset.get('role') == 'bibliography':
            bib = (ROOT / asset['path']).read_bytes().decode('utf-8')
            _, detail = package.add('itinere:bibliography', 'Itiner-e — bibliography', 'itinere', 'Bibliography', {'BibTeX': bib})
            detail['entries'] = bibliography_entries(bib)
        if asset.get('role') == 'fields':
            paragraphs, blocks = field_document(ROOT / asset['path'])
            _, detail = package.add('itinere:fields', 'Itiner-e — field definitions', 'itinere', 'Source note', paragraphs)
            detail['blocks'] = blocks


def build_foundation(stage, manifest):
    sources = {r['id']: r for r in manifest['sources']}
    package = Package(stage, set(SOURCES))
    for key, adapter in zip(SOURCES, (cities, roads, maritime, gazetteer)):
        adapter(package, sources[key])
    package.finish()
