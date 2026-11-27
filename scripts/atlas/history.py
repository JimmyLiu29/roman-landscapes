"""Reviewed local census extract with separately typed activity and biography links."""
import gzip
import json
import re
from collections import Counter

from foundation import ROOT, inside
from atlas.fields import date_item, warnings

SOURCE = 'wikidata-history'
CATEGORIES = {'events': 'Historical events', 'people': 'Historical people'}
BIOGRAPHY = {'birthplace', 'deathplace', 'burial-place'}
STRONG = {'documented', 'source-identifier'}
ROLE_NAMES = {'participant-event-town': 'event-participant-town', 'commander-event-town': 'military-command-town',
              'P607-event-town': 'conflict-participant-town', 'P1344-event-town': 'event-participant-town'}


def statements(entity, prop):
    return [s for s in entity.get('claims', {}).get(prop, [])
            if s.get('rank') != 'deprecated' and s['mainsnak'].get('snaktype') == 'value']


def value(statement):
    return statement['mainsnak'].get('datavalue', {}).get('value')


EVENT_DATES = {'P585': 'Date', 'P580': 'Start', 'P582': 'End', 'P571': 'Inception',
               'P576': 'Dissolution', 'P577': 'Publication'}
PERSON_DATES = {'P569': 'Birth', 'P570': 'Death', 'P1317': 'Floruit',
                'P2031': 'Activity begins', 'P2032': 'Activity ends'}
EVENT_ROLES = {'event-location', 'event-administrative-location', 'battle-near-town'}
PERSON_ROLES = BIOGRAPHY | {'work-location', 'residence', *ROLE_NAMES}


def time_item(prop, statement):
    qualifiers = [{'property': p, 'snaks': snaks} for p, snaks in statement.get('qualifiers', {}).items()]
    rank = statement.get('rank', 'normal')
    basis = f'Wikidata statement ({rank} rank)'
    label = (EVENT_DATES | PERSON_DATES).get(prop, prop)
    snak = statement['mainsnak']
    if snak.get('snaktype', 'value') != 'value':
        display = 'Unknown source date' if snak['snaktype'] == 'somevalue' else 'No source date'
        return date_item(prop, snak, label=label, qualifiers=qualifiers, basis=basis,
                         display=display, statement_id=statement['id'])
    v = value(statement)
    raw = v['time']
    year = int(raw.split('T')[0].lstrip('+-').split('-')[0]) * (-1 if raw.startswith('-') else 1)
    precision = v['precision']
    calendar = {'Q1985786': 'Julian', 'Q1985727': 'Gregorian'}.get(v['calendarmodel'].split('/')[-1])
    result = date_item(prop, v, label=label,
                       year=year, precision=precision, calendar=calendar,
                       qualifiers=qualifiers,
                       basis=basis, statement_id=statement['id'])
    if year and precision >= 10:
        parts = raw.split('T')[0].lstrip('+-').split('-')
        suffix = '-'.join(parts[1:2 if precision == 10 else 3])
        result['display'] += ' (month/day: ' + suffix + ')'
    if precision < 9:
        result['display'] += f' (coarse precision {precision})'
    return result


def time_statements(entity):
    return [(prop, s) for prop, claims in entity.get('claims', {}).items() for s in claims
            if s['mainsnak'].get('datatype') == 'time']


def read_inputs(source):
    native = json.loads(gzip.decompress((ROOT / source['path']).read_bytes()))
    selection = json.loads((ROOT / next(a['path'] for a in source['assets'] if a['role'] == 'selection')).read_text())
    assert native['source_sha256'] == selection['source_sha256']
    return native['entities'], selection


def label(entity):
    return entity.get('labels', {}).get('en', {}).get('value') or next(iter(entity.get('labels', {}).values()), {}).get('value', entity['id'])


def points_geometry(points):
    points = [list(p) for p in sorted({tuple(p) for p in points})]
    return {'type': 'Point', 'coordinates': points[0]} if len(points) == 1 else {'type': 'MultiPoint', 'coordinates': points}


def build_history(package, sources):
    source = sources[SOURCE]; entities, selection = read_inputs(source)
    lookup = {r['id']: r for r in package.catalog}
    rows = selection['records']; selected_events = {r['id']: r for r in rows['events']}
    statement_index = {s['id']: {'Entity': q, 'Revision': e['lastrevid'], 'Property': prop, 'Statement': s}
                       for q, e in entities.items() for prop, claims in e.get('claims', {}).items() for s in claims}
    crosswalks = {(c['entity'], c['node']): c for c in selection['town_crosswalks']}

    def evidence(link):
        ids = {link[k] for k in ['statement', 'source_statement'] if link.get(k)}
        event = link.get('event')
        if event:
            for s in statements(entities[event], 'P276') + statements(entities[event], 'P131'):
                ids.add(s['id'])
        # Preserve containment statements for identifier paths, including qualifiers.
        for q in set(re.findall(r'\bQ\d+\b', link.get('via', ''))):
            for s in statements(entities[q], 'P131'):
                ids.add(s['id'])
        return [statement_index[s] for s in sorted(ids)]

    counts = Counter(); nodes = set(); modes = Counter(); cohorts = Counter(); relations_count = Counter()
    event_people = set()
    for kind in ['events', 'people']:
        for row in rows[kind]:
            q = row['id']; e = entities[q]; links = []
            assert row['period'] in {'overlap', 'event-associated'} and row['revision'] == e['lastrevid']
            checked = []
            for original in row['town_links']:
                assert original['role'] in (EVENT_ROLES if kind == 'events' else PERSON_ROLES)
                assert original['tier'] in STRONG and original['node'] in lookup
                role = ROLE_NAMES.get(original['role'], original['role'])
                group = 'biography' if role in BIOGRAPHY else 'activity' if kind == 'people' else 'event'
                proof = evidence(original)
                checked.extend(p['Statement'] for p in proof)
                basis = '; '.join(f"Wikidata {p['Entity']} revision {p['Revision']}, {p['Property']}, statement {p['Statement']['id']} ({len(p['Statement'].get('references', []))} references)" for p in proof)
                crosswalk = crosswalks.get((original.get('place'), original['node']))
                if crosswalk: basis += '; ' + crosswalk['basis']
                basis += '; ' + original['tier'] + ': ' + original.get('via', '')
                if original.get('event'):
                    basis += '; associated event: ' + label(entities[original['event']])
                    if original['event'] not in selected_events:
                        basis += ' (supporting source record; outside the displayed event subset)'
                    else:
                        event_people.add((q, original['event'], role.removesuffix('-town'), original['source_statement']))
                links.append({'event': None, 'place': None, 'via': '', **original, 'role': role, 'association_group': group, 'basis': basis,
                              'statement_evidence': proof})
            assert links
            geometries = {}
            for group, layer in [('activity', 'people'), ('biography', 'people-biography')]:
                places = [lookup[l['node']]['bbox'][:2] for l in links if l['association_group'] == group]
                if places: geometries[layer] = points_geometry(places)
            coordinates = []
            if kind == 'events':
                for s in statements(e, 'P625'):
                    v = value(s)
                    if v.get('globe', '').endswith('/Q2') and inside([v['longitude'], v['latitude']]):
                        coordinates.append((v['longitude'], v['latitude']))
            exact = len(set(coordinates)) == 1
            geometry = points_geometry(coordinates if exact else [lookup[l['node']]['bbox'][:2] for l in links])
            mode = 'source-event-coordinate' if exact else 'associated-town-anchor'; modes[mode] += 1
            summary = {'Description': row['description'], 'Map position': mode.replace('-', ' '),
                'Period evidence': 'Dated associated event' if row['period'] == 'event-associated' else 'Native life / activity / event dates',
                'Roman context': 'Text-only source context' if row['scope_path'] == ['text-context-review'] else 'Source relationship / reviewed context',
                'Frozen Wikidata revision': e['lastrevid']}
            native_dates = time_statements(e)
            dates = [time_item(p, s) for p, s in native_dates]
            checked.extend(s for _, s in native_dates)
            for item, (_, claim) in zip(dates, native_dates):
                if claim['rank'] == 'deprecated' or claim['mainsnak']['snaktype'] != 'value':
                    continue
                heading = item['label']
                summary[heading] = ' / '.join(filter(None, (summary.get(heading), item['display'])))
            if kind == 'people':
                cohorts['activity'] += 'people' in geometries
                cohorts['biography'] += 'people-biography' in geometries
                cohorts['both'] += len(geometries) == 2
                cohorts['biography_only'] += 'people' not in geometries
                summary['Associations'] = 'Activity / events and birth / death / burial' if len(geometries) == 2 else 'Activity / events' if 'people' in geometries else 'Birth / death / burial only'
            aliases = [q] + [a['value'] for lang in ('en', 'la') for a in e.get('aliases', {}).get(lang, [])]
            record, detail = package.add('wikidata:' + q, row['label'], SOURCE,
                'Historical event' if kind == 'events' else 'Historical person', e, geometry,
                aliases=aliases, layer='events' if kind == 'events' else None, category=CATEGORIES[kind], summary=summary,
                search_terms=' '.join(dict.fromkeys(lookup[l['node']]['label'] for l in links)),
                notes=['Dates and town associations follow source evidence; this is not a complete chronology or an importance ranking.',
                       'Work, residence, participation and command are activity associations. Birth, death and burial are shown separately; command does not establish personal presence.' if kind == 'people' else 'A town association is not an exact event coordinate.',
                       'Resolved life or event dates do not date every association or show that every office preceded 565 CE. Source precision, alternative dates, qualifiers and references remain available.'])
            if kind == 'events':
                geometries = {'events': geometry}
            detail['occurrences'] = {layer: {'geometry': geom, 'position_basis': mode}
                                     for layer, geom in geometries.items()}
            detail['dates'] = dates
            detail['source_url'] = f"https://www.wikidata.org/w/index.php?title={q}&oldid={e['lastrevid']}"
            detail['history_links'] = links
            detail['history_selection'] = {k: row[k] for k in ['period', 'scope_path', 'classification_basis']}
            detail['tables'] = {}
            for group, heading in [('event', 'Event town associations'), ('activity', 'Activity and event associations'), ('biography', 'Birth, death and burial places')]:
                subset = [l for l in links if l['association_group'] == group]
                if subset:
                    detail['tables'][heading] = [{'Town': lookup[l['node']]['label'], 'Role': l['role'], 'Evidence': l['basis'], 'Native statements': l['statement_evidence']} for l in subset]
            dated_events = row.get('dated_event_evidence', [])
            if dated_events:
                support = []
                for d in dated_events:
                    event = entities[d['event']]
                    date_claims = {p: statements(event, p) for p in EVENT_DATES if statements(event, p)}
                    association = statement_index[d['statement']]
                    checked.append(association['Statement'])
                    checked.extend(s for group in date_claims.values() for s in group)
                    support.append(dict(event_qid=d['event'], event_revision=event['lastrevid'],
                                        event_label=label(event), role=d['role'],
                                        event_record_id='wikidata:' + d['event'] if d['event'] in selected_events else None,
                                        association_statement=association, date_statements=date_claims,
                                        dates=[time_item(p, s) for p, claims in date_claims.items() for s in claims]))
                detail['dated_supporting_events'] = support
            codes = ['wikidata_dating_scope_limit']
            if kind == 'events' or 'people' in geometries:
                codes.append('wikidata_command_not_presence')
            if row['scope_path'] == ['text-context-review']:
                codes.append('wikidata_text_only_roman_context')
            if any(not s.get('references') for s in checked):
                codes.append('wikidata_unreferenced_statements')
            detail['warnings'] = warnings(codes)
            for link in links:
                package.relation(record['id'], link['node'], link['role'], link['basis'], SOURCE)
                package.relations[-1]['association_group'] = link['association_group']
                nodes.add(link['node']); relations_count[kind] += 1
            counts[kind] += 1
    for person, event, role, statement in sorted(event_people):
        package.relation('wikidata:' + person, 'wikidata:' + event, role,
                         f"Wikidata statement {statement}; associated event, not proof of personal presence.", SOURCE)
        package.relations[-1]['association_group'] = 'activity'
    accounting = {**dict(counts), 'associated_towns': len(nodes), 'person_associations': dict(cohorts),
        'town_relation_rows': dict(relations_count), 'candidates': selection['candidate_totals'],
        'baseline': {k: len(v) for k, v in selection['baseline'].items()},
        'added': {k: len({r['id'] for r in rows[k]} - set(selection['baseline'][k])) for k in rows},
        'removed': {k: sorted(set(selection['baseline'][k]) - {r['id'] for r in rows[k]}) for k in rows},
        'text_only_scope': {k: sum(r['scope_path'] == ['text-context-review'] for r in rows[k]) for k in rows}}
    source['accounting'] = accounting
    return {**accounting, 'categories': CATEGORIES, 'position_basis': dict(modes),
            'scope': selection['admission']}
