"""Lossless tabular decoding; source-specific semantics belong in adapters."""
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'


def xlsx_sheets(path):
    """Keep stored scalar text, blank cells and sheet row numbers, without date coercion."""
    with zipfile.ZipFile(path) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(n.itertext()) for n in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('s:si', NS)]
        targets = {r.get('Id'): posixpath.normpath(posixpath.join('xl', r.get('Target'))).lstrip('/')
                   for r in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        result = {}
        for sheet in ET.fromstring(archive.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS):
            root = ET.fromstring(archive.read(targets[sheet.get(REL)]))
            rows = []
            for row in root.findall('s:sheetData/s:row', NS):
                cells = {}
                for cell in row.findall('s:c', NS):
                    value = cell.findtext('s:v', '', NS)
                    if cell.get('t') == 's': value = strings[int(value)] if value else ''
                    if cell.get('t') == 'inlineStr':
                        value = ''.join(cell.find('s:is', NS).itertext())
                    cells[re.sub(r'\d+', '', cell.get('r'))] = value
                if any(value != '' for value in cells.values()): rows.append({'row': int(row.get('r')), 'cells': cells})
            result[sheet.get('name')] = rows
        return result


def table_rows(rows, header_row=1):
    """Map explicit header columns; retain unlabeled populated columns, never drop them."""
    header = next(row['cells'] for row in rows if row['row'] == header_row)
    columns = dict(header)
    for row in rows:
        if row['row'] > header_row:
            for col, value in row['cells'].items():
                if value and col not in columns: columns[col] = ''
    labels, used = {}, set()
    for col, name in columns.items():
        label = name or f'Column {col}'
        if label in used: label += f' [{col}]'
        labels[col] = label; used.add(label)
    return [{'source_row': row['row'], **{label: row['cells'].get(col, '') for col, label in labels.items()}}
            for row in rows if row['row'] > header_row]
