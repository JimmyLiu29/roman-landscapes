"""Cross-check evidence and embedded table counts independently of the pack writer."""
from collections import Counter, defaultdict
from decimal import Decimal
from atlas.fields import coordinate_status
from readings import plain_fields


class Accounts:
    def __init__(self):
        self.count = Counter()
        self.site_totals = {}
        self.observations = defaultdict(Decimal)
        self.attached = defaultdict(set)
        self.warnings = Counter()
        self.towns = set()

    def inspect(self, r, d):
        k, n = d['render_kind'], d['native']
        codes = {w['code'] for w in d.get('warnings', [])}
        self.warnings.update(codes)
        self.count[k] += 1
        if k == 'hanson_settlement':
            assert r['id'] == 'hanson:' + n['Primary Key']
            assert all(row['Primary Key'] == n['Primary Key'] for group in d.get('tables', {}).values() for row in group)
        elif k == 'hanson_bibliography':
            assert len(d['entries']) == 47
        elif k == 'itinere_bibliography':
            assert len(d['entries']) == 627
        elif k == 'itinere_road':
            assert d['native_crs']['properties']['name'].endswith('3395')
            self.count['ferries'] += r['kind'] == 'Source ferry connector'
        elif k == 'orbis_route':
            self.count['slowover'] += n['t'] == 'slowover'
        elif k == 'pleiades_place':
            assert d['reading'] == plain_fields(n)
            assert len(d['names']) == len(d['tables']['Names'])
            self.count[d['geometry_status'] + '_names'] += len(d['names'])
        elif k in ('economy_mine', 'economy_shipwreck', 'economy_press_group'):
            row = d.get('normalized_fields', n)
            x, y = {'economy_mine': ('longitude','latitude'), 'economy_shipwreck': ('Longitude','Latitude'),
                    'economy_press_group': ('loclong','loclat')}[k]
            assert d['geometry_status'] == coordinate_status(row[x],row[y])
            if k == 'economy_shipwreck':
                assert 'shipwrecks_approximate_coords' in codes
                self.count['row_ids'] += r['id'].startswith('shipwrecks:row:')
                assert ('normalized_fields' in d) == ('shipwrecks_layout_repaired' in codes) == (n['source_row'] in (5,6))
                for table, rows in d['tables'].items():
                    for item in rows:
                        assert item['source_row'] not in self.attached[table]
                        self.attached[table].add(item['source_row'])
                        if table == 'Amphorae (Wreck ID)':
                            assert item['Wreck ID'] == row['Wreck ID'] and row['Wreck ID']
                        else:
                            assert item['objloc'] == row['locid'] and row['locid']
            if k == 'economy_press_group':
                self.count['presses'] += int(n['presses'])
        elif r['id'] == 'shipwrecks:unmatched':
            assert len(n) == 3
            self.attached['unmatched'] = {row['source_row'] for row in n}
        elif k == 'economy_raad_assemblage':
            self.site_totals[n['Assemblage number']] = Decimal(n['Total assemblage size'])
        elif k == 'economy_raad_observation':
            self.observations[n['assemblage_column']] += Decimal(n['frequency'])
        elif r['id'].startswith('raad:type:'):
            assert len(d['tables']['Native type concordance']) == 1
            self.count['raad_concordances'] += 1
        elif k == 'economy_karanis_transaction':
            cols = [col for col in n if col.startswith('Corrected into dr. decimals')]
            assert len(cols) == 2 and all(n[c] == d['summary'][c] for c in cols)
            assert ('karanis_regnal_42339' in codes) == (n['source_row'] in (2584,2607,3446)) == (n['transyear'] == '42339')
        elif k == 'economy_water_reference':
            assert 'water_lost_greek' in codes and '?' in n['drword']
            self.count['water_records'] += int(n['recs'])
        elif k.startswith('history_'):
            self.count['supported'] += bool(d.get('dated_supporting_events'))
            self.count['text_only_' + k] += 'wikidata_text_only_roman_context' in codes
            self.towns.update(l['node'] for l in d['history_links'])
            if k == 'history_person':
                self.count['both'] += len(r['layers']) == 2
                self.count['bio_only'] += r['layers'] == ['people-biography']

    def finish(self, reports, sources):
        counts = {'hanson_settlement':1388,'orbis_route':584,'orbis_place':301,'pleiades_place':32666,
                  'ferries':2,'selected_only_names':29150,'no_representative_coordinate_names':1,
                  'economy_mine':1399,'economy_shipwreck':1818,'row_ids':39,'economy_raad_assemblage':79,
                  'economy_raad_observation':1469,'raad_concordances':268,'economy_raad_type':487,
                  'economy_karanis_transaction':17053,'economy_karanis_archive':1,'economy_press_group':232,
                  'presses':760,'economy_quarry':792,'economy_water_reference':622,'water_records':656,
                  'economy_document_place':25,'history_event':324,'history_person':1208,'supported':70,
                  'both':150,'bio_only':794,'text_only_history_event':5,'text_only_history_person':27}
        for key,value in counts.items():
            assert self.count[key] == value, (key,self.count[key],value)
        assert self.count['slowover'] and self.site_totals == self.observations and len(self.towns) == 383
        assert len(self.attached['Amphorae (Wreck ID)']) == 887
        objs = self.attached['Site objects (objloc = locid)']
        assert len(objs) == 2544 and len(objs | self.attached['unmatched']) == 2547
        by_id = {s['id']:s for s in sources}
        assert by_id['oxford-mines']['accounting']['empty_sheets'] == ['Sheet1']
        assert by_id['itinere']['accounting']['roma_vertex_km'] < 2
        assert by_id['pleiades']['accounting']['referenced_nonregional_names'] == 1
        assert reports['economy']['evidence_records'] == 23385
        assert reports['history']['associated_towns'] == len(self.towns)
        assert reports['history']['events'] == self.count['history_event']
        assert all(s['accounting'] == reports['economy']['sources'][s['id']] for s in sources
                   if s['id'] in reports['economy']['sources'])
