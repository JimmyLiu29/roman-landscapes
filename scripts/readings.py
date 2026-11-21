"""Reading views derived from the locked source files; native fields remain available."""
from html import unescape
from html.parser import HTMLParser
import re
import xml.etree.ElementTree as ET
import zipfile


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('style', 'script', 'xml', 'head'):
            self.hidden += 1
        if tag in ('br', 'p', 'div', 'li', 'tr', 'td', 'blockquote'):
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in ('style', 'script', 'xml', 'head'):
            self.hidden = max(0, self.hidden - 1)
        if tag in ('p', 'div', 'li', 'td', 'blockquote'):
            self.parts.append(' ')

    def handle_data(self, text):
        if not self.hidden:
            self.parts.append(text)


def plain_text(text):
    # Decode encoded markup before stripping it. Keep literal inequality signs.
    text = re.sub(r'&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]\w*);', lambda m: unescape(m[0]), text)
    if re.search(r'<(?:[a-zA-Z][\w:-]*(?:\s|/?>)|!)', text):
        parser = PlainText()
        parser.feed(text)
        parser.close()
        text = ''.join(parser.parts)
    return ' '.join(text.split())


def plain_fields(row):
    result = {k: plain_text(v) for k,v in row.items() if v.strip()}
    if row.get('name_type') == 'undefined':
        result['name_type'] = 'Unspecified'
    return {k:v for k,v in result.items() if v}


def city_references(rows):
    works = {}
    redirects = {}
    entries = []
    for row in rows:
        text = row['Bibliography']
        item = {'row':row['source_row'], 'text':text}
        if ', see ' in text:
            key, target = text.split(', see ')
            redirects[key] = target
        else:
            year = re.search(r'\((\d{4}[^)]*)\)', text)
            key = text.split(',')[0]
            second = re.search(r', and ([^,]+),',text[:year.start()])
            if second:
                key += ' and ' + second[1]
            key += ' ' + year[1]
            if text.count('(') != text.count(')'):
                item['note'] = 'The source entry ends here; the publication details are incomplete.'
        item['key'] = key
        works[key] = item
        entries.append(item)

    for key, target in redirects.items():
        target_key = target.split(',')[0] + ' ' + target.split()[-1] if ',' in target else target
        works[key]['see_row'] = works[target_key]['row']
        works[key]['target'] = target_key

    variants = {'Cornell and Mathews 1982':'Cornell and Matthews 1982',
                'Carreras Monfort 1995-1996':'Carreras-Monfort 1995-1996',
                'Lepelley 1979-1981':'Lepelley 1979 and 1981',
                'Millett 1990: Table 6.5':'Millett 1990','Millett 1990: Table 4.4':'Millett 1990'}
    def resolve(token):
        entry = works.get(variants.get(token,token))
        if entry is None:
            return {'token':token,'match':'unresolved'}
        full = works.get(entry.get('target'),entry)
        return {'token':token,'match':'variant' if token in variants else 'exact',
                'source_row':entry['row'],'row':full['row'],'text':full['text'],
                **({'note':full['note']} if 'note' in full else {})}
    return entries, resolve


BIB_HEADER = re.compile(r'\s*@(\w+)\s*\{([^,]+),')
FIELD = re.compile(r'\s*([\w-]+)\s*=\s*')
PUBLIC_FIELDS = set('author editor year title journal booktitle volume pages doi url publisher number'.split())


def bibliography_entries(text):
    pos = 0
    entries = []
    while text[pos:].strip():
        header = BIB_HEADER.match(text,pos)
        if not header:
            raise ValueError(f'Invalid bibliography entry at offset {pos}')
        item = {'type':header[1],'key':header[2]}
        pos = header.end()
        while True:
            end = re.compile(r'\s*}').match(text,pos)
            if end:
                pos = end.end()
                break
            field = FIELD.match(text,pos)
            if not field:
                raise ValueError(f'Invalid field in {item["key"]}')
            pos = field.end()
            if text[pos]=='{':
                start = pos+1
                depth = 1
                pos += 1
                while depth:
                    c = text[pos]
                    if c=='\\':
                        pos += 2
                        continue
                    depth += (c=='{') - (c=='}')
                    pos += 1
                value = text[start:pos-1]
            else:
                bare = re.compile(r'[\w-]+').match(text,pos)
                value = bare[0]
                pos = bare.end()
            name = field[1].lower()
            if name in PUBLIC_FIELDS:
                value = value.replace(r'\&','&').replace(r'\textless','<').replace(r'\textgreater','>')
                value = ' '.join(value.translate(str.maketrans('','','{}')).split())
                item[name] = value.replace('--','–') if name=='pages' else value
            pos = re.compile(r'\s*,?').match(text,pos).end()
        entries.append(item)
    return entries


def field_document(path):
    with zipfile.ZipFile(path) as archive:
        body = ET.fromstring(archive.read('word/document.xml')).find('{*}body')
    def paragraph(node):
        return ''.join(t.text or '' for t in node.iterfind('.//{*}t'))
    native = [{'paragraph':n, 'text':paragraph(p)} for n,p in enumerate(body.iterfind('.//{*}p'),1) if paragraph(p)]
    blocks = []
    for node in body:
        if node.tag.endswith('}p') and paragraph(node):
            blocks.append({'paragraph':paragraph(node)})
        elif node.tag.endswith('}tbl'):
            rows = [['\n'.join(paragraph(p) for p in cell.findall('{*}p')) for cell in tr.findall('{*}tc')]
                    for tr in node.findall('{*}tr')]
            blocks.append({'rows':rows})
    return native, blocks
