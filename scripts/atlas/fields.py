"""Typed presentation fields, preserving the native source values separately."""
import math
import re
from foundation import inside
from readings import plain_text


WARNING_CATALOG = {
    'water_lost_greek': 'The source records Greek word characters as question marks. The original text cannot be recovered from these cells.',
    'shipwrecks_approximate_coords': 'Source coordinates are deliberately approximate and cannot locate a wreck precisely.',
    'shipwrecks_layout_repaired': 'The locked workbook stores part of this row two columns to the right. The native and normalized fields are both available.',
    'raad_non_additive_quantification': 'Assemblages use different quantification methods. Counts across methods cannot be combined.',
    'karanis_collection_only_anchor': 'The map anchor locates the collection. It supplies no location for individual transactions.',
    'karanis_dual_corrected_drachma': 'The two corrected drachma columns represent separate source fields.',
    'karanis_regnal_42339': 'The regnal cell contains 42339, consistent with spreadsheet date coercion.',
    'presses_grouped_summary': 'Each row describes a group and may represent several presses.',
    'quarries_archive_only': 'The quarry table supplies no coordinates or external place identifiers.',
    'wikidata_text_only_roman_context': 'Roman context rests on reviewed textual evidence.',
    'wikidata_unreferenced_statements': 'One or more statements used for dates or associations have no references in this revision.',
    'wikidata_command_not_presence': 'Command, participation and town associations do not establish personal presence.',
    'wikidata_dating_scope_limit': 'Resolved dates establish period membership. They do not date every town association.',
}


def warnings(codes):
    return [{'code': code, 'message': WARNING_CATALOG[code]} for code in sorted(set(codes))]


def clean_fields(row, html_fields=frozenset()):
    result = {}
    for key, value in row.items():
        if not isinstance(value, str):
            result[key] = value
            continue
        if key in html_fields:
            value = plain_text(value)
            if key == 'name_type' and value == 'undefined':
                value = 'Unspecified'
        else:
            value = ' '.join(re.sub(r'[\x00-\x1f\x7f]', ' ', value).split())
        if value:
            result[key] = value
    return result


def coordinate_status(lon, lat):
    try:
        point = [float(lon), float(lat)]
    except (TypeError, ValueError):
        return 'missing_coordinate'
    if not all(map(math.isfinite, point)):
        return 'missing_coordinate'
    if point == [0, 0]:
        return 'placeholder_zero'
    return 'mapped' if inside(point) else 'outside_map_bounds'


def date_item(key, raw, *, label=None, year=None, precision=None, calendar=None,
              qualifiers=(), sentinel=None, basis=None, statement_id=None, display=None):
    if display is None:
        display = str(raw) if raw not in ('', None) else 'Unknown'
        if sentinel:
            display = sentinel.replace('_', ' ').capitalize()
        elif year == 0:
            display = '0 (source value)'
        elif year is not None:
            display = f'{abs(year)} {"BCE" if year < 0 else "CE"}'
    return dict(key=key, label=label or key, display=display, raw=raw, year=year,
                precision=precision, calendar=calendar, qualifiers=list(qualifiers),
                sentinel=sentinel, basis=basis, statement_id=statement_id)


def source_dates(row, keys, source):
    result = []
    for key in keys:
        raw = row[key]
        value = str(raw).strip()
        year = int(float(value)) if re.fullmatch(r'[+-]?\d+(?:\.0+)?', value) else None
        sentinel = None
        if source == 'itinere':
            sentinel = {0: 'uncertain_zero', 9999: 'missing_9999'}.get(year)
        elif source == 'oxford-presses' and year in (-999, 999):
            sentinel = 'unspecified_bound'
        elif source == 'oxford-presses' and year == 9999:
            # An undocumented bound in this snapshot. Preserve the value without assigning an era.
            result.append(date_item(key, raw, basis='Uninterpreted source bound'))
            continue
        elif source == 'oxford-karanis' and key == 'transyear':
            if year == 42339:
                sentinel = 'spreadsheet_date_coercion'
            year = None  # Regnal numbers do not express CE years.
        if key in ('Low_Date_E', 'Up_Date_E'):
            year = None
        result.append(date_item(key, raw, year=None if sentinel else year, sentinel=sentinel, basis='Source field'))
    return result


def corrected_drachma(row):
    columns = {k: v for k, v in row.items() if k.startswith('Corrected into dr. decimals')}
    assert len(columns) == 2
    return columns
