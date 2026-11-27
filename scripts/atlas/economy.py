"""Frozen economic exports, native joins and explicit source-qualified place links."""
import csv
import hashlib
import io
import json
from atlas.fields import coordinate_status
import re
from collections import Counter, defaultdict

from foundation import ROOT, read_csv
from formats import xlsx_sheets, table_rows

CATEGORIES = {'oxford-mines': 'Mining and metals', 'oxford-shipwrecks': 'Shipwrecks and cargo',
              'raad': 'Amphorae and commodities', 'oxford-karanis': 'Fiscal records',
              'oxford-presses': 'Oil and wine production', 'oxford-quarries': 'Stone quarries',
              'oxford-water': 'Water technologies'}


def point(lon, lat):
    if coordinate_status(lon, lat) == 'mapped':
        return {'type': 'Point', 'coordinates': [float(lon), float(lat)]}
    return None


def add(package, id_, label, source, kind, native, geometry=None, *, evidence=True, mapped=True,
        summary=None, aliases=None, notes=None, related=None, search_terms=None):
    index, detail = package.add(id_, label, source, kind, native, geometry,
        category=CATEGORIES[source], summary=summary, aliases=aliases, notes=notes, related=related,
        search_terms=search_terms, layer='economy' if geometry and mapped else None)
    index['entity'] = 'EvidenceRecord' if evidence else 'Place' if kind.endswith('place') or kind == 'Assemblage' else 'Source record'
    return index, detail


def mines(package, source):
    sheets = xlsx_sheets(ROOT / source['path'])
    rows = table_rows(sheets['OxREP Mines 3 0 - 20250408'])
    mapped = 0
    for row in rows:
        geometry = point(row['longitude'], row['latitude']); mapped += bool(geometry)
        metals = {k.removeprefix('metalMined'): v for k, v in row.items() if k.startswith('metalMined') and v not in ['', '0', 'FALSE']}
        add(package, 'mines:' + row['mineID'], row['site'] or 'Unnamed mine ' + row['mineID'], source['id'], 'Mining evidence', row, geometry,
            aliases=[row['ancientName']], search_terms=' '.join([*metals, row['province'], row['country'], row['miningDistrict']]),
            summary={'Metals (source flags)': '; '.join(f'{k}: {v}' for k, v in metals.items()) or 'Not specified',
                     'Date fields': '; '.join(f'{k}: {row[k] or "unknown"}' for k in ['notBeforeOpeningDate', 'notAfterOpeningDate', 'notBeforeClosingDate', 'notAfterClosingDate', 'inUseDate']),
                     'Coordinate accuracy (source)': row['coordinateAccuracy'] or 'unknown', 'Reference': row['references']},
            notes=['A source mining location, not an inferred settlement identity. Metal flags and date uncertainties remain as supplied.'] +
                  ([] if geometry else ['No usable source coordinate within physical-map coverage; all original location fields remain available.']))
    source['accounting'] = {'input_records': len(rows), 'evidence_records': len(rows), 'mapped': mapped,
                            'unmapped': len(rows) - mapped, 'empty_sheets': [k for k, v in sheets.items() if not v]}


def wreck_rows(source):
    with (ROOT / source['path']).open('rb') as stream:
        fingerprint = hashlib.file_digest(stream, 'sha256').hexdigest()
    assert fingerprint == source['sha256'] == 'eaf55526903599c0ef4ca10bc34daf942317f24649f6a253ab8b56876338bc2c', 'Review the source-scoped column repair before changing Shipwrecks snapshots'
    sheets = xlsx_sheets(ROOT / source['path'])
    rows = table_rows(sheets['Shipwrecks'])
    repaired = {}
    labels = list(sheets['Shipwrecks'][0]['cells'].values())
    for row in rows:
        if row['source_row'] not in [5, 6]: continue
        assert row['locid'].isdigit() and row['Wreck Name'] and row['Parker Number'].isdigit()
        assert not row['Wreck ID']
        normalized = dict(row)
        for i, label in enumerate(labels[8:], 8): normalized[label] = row.get(labels[i + 2], '') if i + 2 < len(labels) else ''
        repaired[row['source_row']] = normalized
    return sheets, rows, repaired


def wreck_id(row):
    return 'shipwrecks:wreck:' + row['Wreck ID'] if row['Wreck ID'] else f'shipwrecks:row:{row["source_row"]}'


def shipwrecks(package, source):
    sheets, rows, repaired = wreck_rows(source)
    amphorae = table_rows(sheets['Amphorae']); objects = table_rows(sheets['Shipwreck Objects'])
    by_wreck, by_location = defaultdict(list), defaultdict(list)
    for row in amphorae: by_wreck[row['Wreck ID']].append(row)
    for row in objects: by_location[row['objloc']].append(row)
    ids, locids, mapped, anonymous = set(), set(), 0, 0
    for original in rows:
        row = repaired.get(original['source_row'], original)
        if row['Wreck ID']: ids.add(row['Wreck ID'])
        else: anonymous += 1
        if row['locid']: locids.add(row['locid'])
        geometry = point(row['Longitude'], row['Latitude']); mapped += bool(geometry)
        cargo = by_wreck.get(row['Wreck ID'], []) if row['Wreck ID'] else []
        related = {'Amphorae (Wreck ID)': cargo, 'Site objects (objloc = locid)': by_location.get(row['locid'], []) if row['locid'] else []}
        _, detail = add(package, wreck_id(row), row['Wreck Name'] or row['Site Name'] or 'Unnamed wreck', source['id'], 'Shipwreck evidence', original, geometry,
            related=related, aliases=[row['Site Name']], search_terms=' '.join([row['Country'], row['Other cargo'], *(r['Amphora type'] for r in cargo)]),
            summary={'Earliest date': row['Earliest Date'] or 'unknown', 'Latest date': row['Latest Date'] or 'unknown',
                     'Dating comment': row['Dating comment'], 'Cargo / other finds': row['Other cargo'], 'Reference': row['Reference']},
            notes=['Locations are deliberately approximate in the source and are unsuitable for locating wrecks precisely.',
                   'Amphorae join by Wreck ID. Objects join by native site locid; these are site associations, not an inferred trade route.'] +
                  (['This source row lacks a native Wreck ID; its internal ID is scoped to the frozen workbook row.'] if not row['Wreck ID'] else []))
        if original['source_row'] in repaired:
            detail['normalized_fields'] = row
            detail['notes'].append('Pinned workbook layout repair: in source rows 5–6, columns I:AD are stored two columns to the right (K:AF). The native Wreck ID matches the Amphorae table. Raw fields are unchanged; the normalized view and joins use that explicit shift.')
    missing_amphorae = [r for r in amphorae if r['Wreck ID'] not in ids]
    missing_objects = [r for r in objects if r['objloc'] not in locids]
    assert not missing_amphorae
    add(package, 'shipwrecks:unmatched', 'Shipwrecks — unmatched object rows', source['id'], 'Source note', missing_objects, evidence=False,
        notes=['Native objloc references absent locations. No coordinates, wreck association or replacement identity have been inferred.'])
    source['accounting'] = {'input_records': len(rows), 'evidence_records': len(rows), 'mapped': mapped, 'unmapped': len(rows) - mapped,
        'native_wreck_ids': len(ids), 'row_scoped_ids': anonymous, 'native_location_ids': len(locids),
        'amphora_rows': len(amphorae), 'amphora_rows_joined': len(amphorae), 'object_rows': len(objects),
        'object_rows_joined': len(objects) - len(missing_objects), 'unmatched_object_rows': len(missing_objects),
        'layout_repaired_source_rows': sorted(repaired)}


def raad_tables(source):
    return {name: table_rows(rows) for name, rows in xlsx_sheets(ROOT / source['path']).items()}


def raad(package, source):
    tables = raad_tables(source)
    sites = {r['Assemblage number']: r for r in tables['Site data']}
    types = {r['RAAD type number']: r for r in tables['Rhine assemblages'] if r['RAAD type number'].isdigit()}
    concordance = {r['RAAD type number']: r for r in tables['Southampton and RAAD types conc']}
    pleiades_count = 0
    for key, row in sites.items():
        label = row['Site name (ancient)'] or row['Site name (modern)']
        add(package, 'raad:site:' + key, f'{label} · assemblage {key}', source['id'], 'Assemblage', row,
            point(row['Long'], row['Lat']), evidence=False, aliases=[row['Site name (modern)'], row['Site name (ancient)']],
            summary={'Quantification method': row['Quantification method'], 'Source total': row['Total assemblage size'],
                     'Consumption dates (AD)': f'{row["Start date (AD)"]} to {row["End date (AD)"]}', 'Reference': row['Reference']},
            notes=['One marker represents this native assemblage. Its amphora observations appear as related records. Separate assemblages at one ancient place retain their own identity and quantification method.'])
        if row['Pleiades']:
            assert row['Pleiades'].isdigit()
            package.relation('raad:site:' + key, 'pleiades:' + row['Pleiades'], 'source-identified-place',
                'RAAD Site data, Assemblage number ' + key + ', supplied Pleiades field', source['id'])
            pleiades_count += 1
    for key, row in types.items():
        add(package, 'raad:type:' + key, row['RAAD form'] + ' · type ' + key, source['id'], 'Amphora type', row, evidence=False,
            related={'Native type concordance': [concordance[key]]}, summary={'Origin (source region)': row['Origin'], 'Contents': row['Contents']},
            notes=['Origin is a source region label, not a supplied town identity or reconstructed route. Blank matrix cells remain absent observations.'])
    for row in tables['Southampton amphorae types']:
        add(package, 'raad:southampton:' + row['Southampton type number'], row['Preferred Amphora Name'], source['id'], 'Reference amphora type', row, evidence=False,
            notes=['Southampton reference type as listed in the native concordance workbook.'])
    # The source concordance includes explicitly alternative type IDs; do not turn "or" into identity.
    unresolved = []
    for key, row in concordance.items():
        value = row['Southampton type number']
        for target in re.findall(r'\d+', value):
            if 'raad:southampton:' + target in package.ids:
                package.relation('raad:type:' + key, 'raad:southampton:' + target,
                    'type-concordance' if value.isdigit() else 'candidate-type-concordance',
                    f'Native concordance Southampton type number = {value}', source['id'])
            else:
                unresolved.append({'type': key, 'target': target, 'value': value})
    observations = [(site, type_, row[site]) for type_, row in types.items() for site in sites if row[site]]
    for site, type_, frequency in observations:
        observation = {'source_sheet': 'Rhine assemblages', 'source_row': types[type_]['source_row'],
                       'assemblage_column': site, 'RAAD type number': type_, 'frequency': frequency}
        _, detail = add(package, f'raad:observation:{site}:{type_}', f'{types[type_]["RAAD form"]} · {sites[site]["Site name (modern)"]} · assemblage {site}',
            source['id'], 'Amphora observation', observation, mapped=False,
            search_terms=' '.join([types[type_]['Contents'], types[type_]['Origin'], sites[site]['Site name (ancient)']]),
            summary={'Frequency': frequency, 'Quantification': sites[site]['Quantification method'],
                'Contents (original)': types[type_]['Contents'], 'Origin (original region)': types[type_]['Origin'],
                'Consumption dates (assemblage, AD)': f'{sites[site]["Start date (AD)"]} to {sites[site]["End date (AD)"]}',
                'Reference': sites[site]['Reference']},
            notes=['Derived directly from a nonempty cell in the original licensed workbook. Counts using MNI, MAX, RBH and total sherds are not added together.'])
        detail['geometry_note'] = 'Location is held by the related source assemblage. This observation has no separate map marker.'
        package.relation(detail['id'], 'raad:site:' + site, 'findspot-assemblage', f'Native matrix assemblage column {site}', source['id'])
        package.relation(detail['id'], 'raad:type:' + type_, 'amphora-type', f'Native RAAD type number {type_}', source['id'])
    totals = [r for r in tables['Rhine assemblages'] if not r['RAAD type number'].isdigit()]
    add(package, 'raad:totals', 'RAAD — native matrix totals', source['id'], 'Source note', totals, evidence=False,
        notes=['These totals are source records. They are not combined across different quantification methods.'])
    source['accounting'] = {'input_records': len(observations), 'evidence_records': len(observations), 'assemblages': len(sites),
        'types': len(types), 'southampton_types': len(tables['Southampton amphorae types']), 'type_concordances': len(concordance),
        'mapped_assemblages': len(sites), 'assemblages_with_pleiades': pleiades_count, 'assemblages_without_pleiades': len(sites) - pleiades_count,
        'unresolved_southampton_refs': unresolved, 'native_totals_rows': len(totals), 'matrix_observations': sum(bool(r[key]) for r in types.values() for key in sites)}


def karanis(package, source, sources):
    rows = table_rows(xlsx_sheets(ROOT / source['path'])['Karanis Tax Rolls'])
    crosswalk = json.loads((ROOT / 'data/place-crosswalks.json').read_text())[0]
    place = next(r for r in read_csv(ROOT / sources['pleiades']['path']) if 'pleiades:' + r['id'] == crosswalk['to'])
    assert place['title'] == 'Karanis'
    _, archive = add(package, 'karanis:archive', 'Karanis — tax-roll archive', source['id'], 'Archive place',
        {'collection': 'Karanis Tax Rolls', 'rows': len(rows), 'source': source['url']}, point(place['representative_longitude'], place['representative_latitude']),
        evidence=False, notes=['A collection-level location anchored to Pleiades by an explicit, documented crosswalk. It does not locate each transaction, payer residence or tax payment.',
                             'Browse individual source transactions. Currency units and both source corrected-drachma columns remain separate. No synthetic total is computed.'])
    archive['archive_source'] = source['id']
    archive['crosswalk'] = crosswalk
    package.relation(crosswalk['from'], crosswalk['to'], crosswalk['role'], crosswalk['basis'], source['id'])
    for row in rows:
        id_ = f'karanis:transaction:{row["source_row"]}'
        _, detail = add(package, id_, f'{row["payer"] or "Unknown payer"} · P.Mich. {row["P.Mich."]}, line {row["Line"]} · row {row["source_row"]}',
            source['id'], 'Tax transaction', row, mapped=False,
            search_terms=' '.join([row['transobj'], row['transcurrency'], row['transvalue'], row['Sex']]),
            summary={'Payer': row['payer'], 'Tax / payment (source)': row['transobj'], 'Amount as recorded': row['transvalue'],
                     'Unit': row['transcurrency'], 'Date bounds (CE)': f'{row["transpost"]} to {row["transante"]}', 'Recipient': row['recipient']},
            notes=['Native transaction row; P.Mich. and Line are document locators, not unique transaction IDs. The date bounds use transpost/transante; regnal transyear remains raw. No individual map point is inferred.'] +
                  (['The source transyear cell contains 42339, consistent with spreadsheet date coercion; it is retained, not interpreted as a historical year.'] if row['transyear'] == '42339' else []))
        detail['geometry_note'] = 'This transaction is browsed in the Karanis archive; the archive anchor is not its observed location.'
        package.relation(id_, 'karanis:archive', 'archive-member', f'Karanis Tax Rolls sheet, row {row["source_row"]}', source['id'])
    source['accounting'] = {'input_records': len(rows), 'evidence_records': len(rows), 'mapped_archive_anchors': 1,
        'transaction_points': 0, 'currency_counts': dict(Counter(r['transcurrency'] for r in rows)),
        'raw_regnal_cells_42339': [r['source_row'] for r in rows if r['transyear'] == '42339']}


def legacy_rows(source):
    return [{'source_row': n, **row} for n, row in enumerate(csv.DictReader(io.StringIO((ROOT / source['path']).read_bytes().decode('cp1252'))), 2)]


def legacy(package, source):
    rows = legacy_rows(source); id_ = source['id']; prefix = id_.removeprefix('oxford-')
    mapped = 0; place_claims = defaultdict(list)
    for row in rows:
        geometry = point(row.get('loclong'), row.get('loclat')); mapped += bool(geometry)
        if id_ == 'oxford-presses':
            label = ' · '.join(v for v in [row['sitename'], row['locname']] if v and v != 'none') or 'Unlocated press group'
            summary = {'Presses (source aggregate)': row['presses'], 'Source records represented': row['recs'],
                       'Province': row['province'], 'Country': row['country']}
            note = 'The native CSV is a grouped summary, not an installation-level export. post/ante values -999 and 999 are unspecified bounds; raw values remain unchanged. Row IDs are snapshot-scoped.'
            kind = 'Press group'
        elif id_ == 'oxford-quarries':
            label = row['sitename'] or 'Unnamed quarry'; kind = 'Quarry record'
            summary = {'Material': row['fs_material'], 'Province': row['province'], 'Country': row['country']}
            note = 'The complete native CSV has no coordinates, external place IDs or individual references. It is retained as a searchable archive; place names do not create identity joins. Material-code fields remain source values.'
        else:
            label = f'{row["docname"]}, line {row["drline"]} · {row["drhead"]}'; kind = 'Water-technology reference'
            summary = {'Classification': row['drhead'], 'Description': row['drdescr'], 'Document': row['docname'],
                       'Line': row['drline'], 'Date bounds (source)': f'{row["post_0"]} to {row["ante_0"]}', 'Source records represented': row['recs']}
            note = 'The source CSV already replaces Greek word characters with question marks. The lost text cannot be recovered by decoding. English classification, document locators and raw fields remain available. Native document place/area IDs do not locate a particular machine.'
        record_id = f'{prefix}:row:{row["source_row"]}'
        _, detail = add(package, record_id, label, id_, kind, row, geometry, summary=summary, notes=[note], search_terms=' '.join(str(v) for v in summary.values()))
        if not geometry and id_ == 'oxford-presses':
            detail['geometry_note'] = ('The supplied coordinate is outside the physical-map bounds; it remains unchanged in the original fields.'
                if row['loclong'] and row['loclat'] and (float(row['loclong']), float(row['loclat'])) != (0, 0)
                else 'No usable location: coordinates are absent or the source uses a 0,0 placeholder. No replacement has been inferred.')
        if id_ == 'oxford-water':
            for key, name, role in [('docsite', 'doc_site', 'document-place'), ('docarea', 'doc_area', 'document-area')]:
                if row[key]:
                    target = f'water:{key}:{row[key]}'
                    place_claims[target].append({'id': row[key], 'name': row[name], 'field': key, 'source_row': row['source_row']})
                    package.relation(record_id, target, role, f'Native {key}={row[key]}, {row["docname"]} line {row["drline"]}', id_)
    for target, claims in place_claims.items():
        labels = sorted(set(r['name'] for r in claims if r['name']))
        add(package, target, labels[0] if labels else 'Unresolved document place ' + target, id_, 'Document place', claims,
            evidence=False, aliases=labels, notes=['Source-native document place/area identity. No geographic coordinate or Pleiades equivalence is supplied.'])
    source['accounting'] = {'input_records': len(rows), 'evidence_records': len(rows), 'mapped': mapped, 'unmapped': len(rows) - mapped,
                            'represented_source_records': sum(int(r['recs']) for r in rows)}
    if id_ == 'oxford-presses': source['accounting']['presses_source_aggregate'] = sum(int(r['presses']) for r in rows)
    if id_ == 'oxford-water': source['accounting'].update({'native_place_area_records': len(place_claims), 'rows_with_lost_greek': sum('?' in r['drword'] for r in rows)})


def build_economy(package, sources):
    for id_, adapter in [('oxford-mines', mines), ('oxford-shipwrecks', shipwrecks), ('raad', raad)]: adapter(package, sources[id_])
    karanis(package, sources['oxford-karanis'], sources)
    for id_ in ['oxford-presses', 'oxford-quarries', 'oxford-water']: legacy(package, sources[id_])
    for id_ in CATEGORIES:
        sources[id_]['status'] = 'imported'
        sources[id_]['selection'] = 'All rows of the retained bulk export. Unlocated records remain searchable; original granularity and fields are retained.'
    sources['raad']['selection'] = 'Complete original CC BY workbook; observations reshaped directly from native matrix cells.'
    evidence = [r for r in package.catalog if r.get('entity') == 'EvidenceRecord']
    return {'evidence_records': len(evidence),
            'categories': dict(sorted(Counter(r['category'] for r in evidence).items())),
            'sources': {id_: sources[id_]['accounting'] for id_ in CATEGORIES}}
