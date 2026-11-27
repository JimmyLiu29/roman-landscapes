"""Atlas record types, natural source order and occurrence identities."""
from collections import Counter, defaultdict
import json

import foundation
from atlas import economy, history
from atlas.fields import clean_fields, coordinate_status, corrected_drachma, source_dates, warnings

KINDS = {
    'Settlement': 'hanson_settlement', 'Mining evidence': 'economy_mine',
    'Source ferry connector': 'itinere_road', 'Road segment': 'itinere_road',
    'Maritime route': 'orbis_route', 'Network place': 'orbis_place',
    'Unresolved network place': 'orbis_place', 'Gazetteer place': 'pleiades_place',
    'Shipwreck evidence': 'economy_shipwreck', 'Assemblage': 'economy_raad_assemblage',
    'Amphora type': 'economy_raad_type', 'Reference amphora type': 'economy_raad_type',
    'Amphora observation': 'economy_raad_observation', 'Archive place': 'economy_karanis_archive',
    'Tax transaction': 'economy_karanis_transaction', 'Press group': 'economy_press_group',
    'Quarry record': 'economy_quarry', 'Water-technology reference': 'economy_water_reference',
    'Document place': 'economy_document_place', 'Historical event': 'history_event',
    'Historical person': 'history_person',
}
SPECIAL = {'hanson:bibliography': 'hanson_bibliography', 'hanson:unmatched': 'hanson_unmatched',
           'itinere:bibliography': 'itinere_bibliography', 'itinere:fields': 'itinere_fields',
           'shipwrecks:unmatched': 'source_note', 'raad:totals': 'source_note'}
RENDER_KINDS = set(KINDS.values()) | set(SPECIAL.values())
LAYERS = ('settlements', 'roads', 'maritime', 'ports', 'economy', 'events', 'people', 'people-biography')
GROUPS = ('maritime_endpoint', 'economic_place', 'findspot_assemblage', 'amphora_type', 'type_concordance',
          'document_place', 'event_town', 'person_activity_town', 'person_biography_town', 'person_event', 'archive_member')
ROLE_GROUP = {role: group for group, roles in zip(GROUPS[:6], [
    ('source-endpoint', 'target-endpoint'), ('source-identified-place', 'archive-place-association'),
    ('findspot-assemblage',), ('amphora-type',), ('type-concordance', 'candidate-type-concordance'),
    ('document-place', 'document-area')]) for role in roles}
ROLE_GROUP['archive-member'] = 'archive_member'
ARCHIVES = {'oxford-karanis': ('economy_karanis_transaction', 17053, 'karanis_collection_only_anchor'),
            'oxford-quarries': ('economy_quarry', 792, 'quarries_archive_only'),
            'oxford-water': ('economy_water_reference', 622, 'water_lost_greek')}
DATE_FIELDS = {
    'hanson_settlement': ('Start Date', 'End Date'),
    'itinere_road': ('Lower_Date', 'Upper_Date', 'Low_Date_E', 'Up_Date_E'),
    'economy_mine': ('notBeforeOpeningDate', 'notAfterOpeningDate', 'notBeforeClosingDate', 'notAfterClosingDate', 'inUseDate'),
    'economy_shipwreck': ('Earliest Date', 'Latest Date'),
    'economy_raad_assemblage': ('Start date (AD)', 'End date (AD)'),
    'economy_karanis_transaction': ('transpost', 'transante', 'transyear'),
    'economy_press_group': ('post_0', 'ante_0', 'post_1', 'ante_1'),
    'economy_water_reference': ('post_0', 'ante_0'),
}
COORDS = {'economy_mine': ('longitude', 'latitude'), 'economy_shipwreck': ('Longitude', 'Latitude'),
          'economy_press_group': ('loclong', 'loclat')}
NOTICES = {'economy_shipwreck': ['shipwrecks_approximate_coords'],
           'economy_raad_assemblage': ['raad_non_additive_quantification'],
           'economy_raad_observation': ['raad_non_additive_quantification'],
           'economy_karanis_archive': ['karanis_collection_only_anchor'],
           'economy_karanis_transaction': ['karanis_collection_only_anchor', 'karanis_dual_corrected_drachma'],
           'economy_water_reference': ['water_lost_greek'], 'economy_quarry': ['quarries_archive_only'],
           'economy_press_group': ['presses_grouped_summary']}


def required_places(sources):
    sites = economy.raad_tables(sources['raad'])['Site data']
    links = json.loads((foundation.ROOT / 'data/place-crosswalks.json').read_bytes())
    selection = json.loads((foundation.ROOT / 'data/wikidata/selection.json').read_bytes())
    return ({'pleiades:' + r['Pleiades'] for r in sites if r['Pleiades']} | {x['to'] for x in links}
            | {l['node'] for rows in selection['records'].values() for r in rows for l in r['town_links']
               if l['node'].startswith('pleiades:')})


def gazetteer(package, record, required_ids):
    places = foundation.read_csv(foundation.ROOT / record['path'])
    names = foundation.read_csv(foundation.ROOT / record['assets'][0]['path'])
    groups = defaultdict(list)
    for n, name in enumerate(names, 2):
        groups[name['place_id']].append((n, name))
    counts = Counter(input_places=len(places), input_names=len(names), referenced_nonregional_names=0)
    for row in places:
        key = 'pleiades:' + row['id']
        lon, lat = row['representative_longitude'], row['representative_latitude']
        geometry = None
        if lon and lat and foundation.inside([float(lon), float(lat)]):
            geometry = {'type': 'Point', 'coordinates': [float(lon), float(lat)]}
            counts['regional_places'] += 1
        else:
            counts['outside' if lon and lat else 'no_representative_coordinate'] += 1
            if key not in required_ids:
                continue
            assert not (lon and lat), 'Review the out-of-bounds referenced place'
        pairs = groups[row['id']]
        rows = [name for _, name in pairs]
        aliases = [name[field] for name in rows for field in ('title','attested_form','romanized_form_1','romanized_form_2','romanized_form_3')]
        _, detail = package.add(key, row['title'], 'pleiades', 'Gazetteer place', row,
                                geometry, aliases=aliases, related={'Names': rows})
        detail['reading'] = clean_fields(row, frozenset(row))
        detail['names'] = [{'key': f"{row['id']}/{name['id']}/{n}", 'source_row': n,
                            'fields': clean_fields(name, frozenset(name))} for n, name in pairs]
        counts['regional_names' if geometry else 'referenced_nonregional_names'] += len(rows)
    assert required_ids <= package.ids
    record.update(accounting=dict(counts), status='imported')


def source_key(record, detail):
    key = record['id']
    parts = key.split(':')
    if key in SPECIAL or key == 'karanis:archive':
        return (9, key)
    if record['source'] == 'raad':
        return ({'site': 0, 'observation': 1, 'type': 2, 'southampton': 3}[parts[1]], *map(int, parts[2:]))
    if parts[0] == 'water' and parts[1] != 'row':
        return (1, key)
    if parts[0] == 'orbis':
        return (int(parts[1] == 'place'), int(parts[-1]))
    if parts[0] == 'pleiades':
        return (0, int(parts[-1]))
    if parts[0] == 'wikidata':
        return (int(record['render_kind'] == 'history_person'), int(parts[-1][1:]))
    if parts[0] == 'itinere':
        return (0, detail['source_feature_index'])
    return (0, detail['native']['source_row'])


def group_relations(relations, index):
    for edge in relations:
        start, end = index[edge['from']], index[edge['to']]
        edge['source'] = start['source']
        role = edge['role']
        if start['source'] != history.SOURCE:
            group = ROLE_GROUP[role]
        elif end['render_kind'] == 'history_event':
            assert role in {r.removesuffix('-town') for r in history.ROLE_NAMES.values()}
            group = 'person_event'
        elif start['render_kind'] == 'history_event':
            assert role in history.EVENT_ROLES
            group = 'event_town'
        else:
            assert role in history.BIOGRAPHY | set(history.ROLE_NAMES.values()) | {'residence', 'work-location'}
            group = 'person_biography_town' if role in history.BIOGRAPHY else 'person_activity_town'
        edge.pop('association_group', None)
        edge['group'] = group
    return sorted(relations, key=lambda e: (GROUPS.index(e['group']), e['from'], e['role'], e['to'], e['basis']))


class Atlas(foundation.Package):
    def add(self, *args, category=None, summary=None, search_terms=None, **kwargs):
        record, detail = super().add(*args, **kwargs)
        if category:
            record['category'] = category
        if summary:
            detail['summary'] = clean_fields(summary)
        if search_terms:
            record['search_terms'] = search_terms
        return record, detail

    def normalize(self):
        feature_index = {(layer, f['id']): f for layer, features in self.layers.items() for f in features}
        self.layers.clear()
        self.index = {r['id']: r for r in self.catalog}
        self.by_id = {d['id']: d for records in self.details.values() for d in records}
        for r in self.catalog:
            key, source = r['id'], r['source']
            d = self.by_id[key]
            kind = SPECIAL.get(key) or KINDS[r['kind']]
            r['render_kind'] = d['render_kind'] = kind
            r.pop('entity', None)
            n = d.get('normalized_fields', d['native'])
            if source in ARCHIVES and kind == ARCHIVES[source][0]:
                r['archive'] = source
            aliases = set(r.get('aliases', []))
            if isinstance(n, dict):
                aliases.update(str(n[k]) for k in ('Primary Key','InLine_FID','mineID','domergueID','romanianRANID',
                    'Wreck ID','Parker Number','Strauss ID','P.Mich.','gid','id','Assemblage number',
                    'RAAD type number','Southampton type number') if n.get(k) not in (None, ''))
            if aliases:
                r['aliases'] = sorted(aliases - {r['label']})
            if kind in DATE_FIELDS:
                d['dates'] = source_dates(n, DATE_FIELDS[kind], source)
            if kind == 'economy_raad_observation':
                site = self.by_id['raad:site:' + n['assemblage_column']]['native']
                d['dates'] = source_dates(site, DATE_FIELDS['economy_raad_assemblage'], source)
                for item in d['dates']:
                    item['basis'] = 'Source assemblage consumption dates'
            codes = NOTICES.get(kind, [])[:]
            if key == 'raad:totals':
                codes.append('raad_non_additive_quantification')
            if 'normalized_fields' in d:
                codes.append('shipwrecks_layout_repaired')
            if kind == 'economy_karanis_transaction':
                d['summary'].update(corrected_drachma(n))
                if n['transyear'] == '42339':
                    codes.append('karanis_regnal_42339')
            if codes:
                d['warnings'] = warnings(codes)
            layer = r.pop('layer', None)
            if 'occurrences' not in d and layer:
                basis = ('documented-collection-anchor' if key == 'karanis:archive' else
                         'source-route-geometry' if layer in ('roads', 'maritime') else 'source-coordinate')
                d['occurrences'] = {layer: dict(geometry=d['geometry'], position_basis=basis)}
            occurrences = d.get('occurrences', {})
            r['layers'] = list(occurrences)
            if occurrences:
                boxes = {}
                for layer, occurrence in occurrences.items():
                    geom = occurrence['geometry']
                    boxes[layer] = bounds(geom)
                    props = dict(feature_index.get((layer, key), {}).get('properties', {}))
                    props.pop('id', None)
                    oid = key + '#' + layer
                    props.update({k: r[k] for k in ('source','label','kind','category') if k in r},
                                 record_id=key, occurrence_id=oid)
                    self.layers[layer].append(dict(type='Feature', id=oid, properties=props, geometry=geom))
                d['geometry'] = occurrences[r['layers'][0]]['geometry']
                r['bbox'] = [func(b[i] for b in boxes.values()) for i, func in enumerate((min,min,max,max))]
                if len(boxes) > 1:
                    r['layer_bboxes'] = boxes
                status = 'mapped'
            elif kind in COORDS:
                status = coordinate_status(*(n[k] for k in COORDS[kind]))
                assert status != 'mapped'
            elif kind == 'orbis_place':
                status = 'missing_coordinate'
            elif kind == 'pleiades_place':
                status = 'selected_only' if 'geometry' in d else 'no_representative_coordinate'
            else:
                status = 'archive_only'
            d['geometry_status'] = status
            if status in ('missing_coordinate', 'placeholder_zero', 'outside_map_bounds', 'no_representative_coordinate'):
                d['geometry_note'] = {'missing_coordinate': 'The source supplies no usable coordinate.',
                    'placeholder_zero': 'The source coordinate is a zero placeholder.',
                    'outside_map_bounds': 'The supplied coordinate lies outside the study bounds.',
                    'no_representative_coordinate': 'The cited place has no representative coordinate.'}[status]
        for records in self.details.values():
            records.sort(key=lambda d: source_key(self.index[d['id']], d))
            for order, d in enumerate(records, 1):
                self.index[d['id']]['source_order'] = order
        self.catalog.sort(key=lambda r: (r['source'], r['source_order'], r['id']))
        self.relations = group_relations(self.relations, self.index)


def bounds(geometry):
    coords = geometry['coordinates']
    if geometry['type'] == 'Point':
        return coords[:2] * 2
    points = [p for line in coords for p in line] if geometry['type'] == 'MultiLineString' else coords
    x, y = zip(*points)
    return [min(x), min(y), max(x), max(y)]
