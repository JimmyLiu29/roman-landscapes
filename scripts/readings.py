"""Reading views derived from the locked source files; native fields remain available."""
from html import unescape
from html.parser import HTMLParser
import unicodedata
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
    # Protect literal angle brackets while recognizing markup in encoded source fields.
    decoded = unescape(text)
    tags = r'(?:a|abbr|b|blockquote|body|br|div|em|font|h[1-6]|head|hr|html|i|li|link|meta|ol|p|script|span|strong|style|sub|sup|table|tbody|td|th|tr|u|ul|xml|o:p)'
    markup = re.compile(r'</?' + tags + r'(?=[\s/>])[^>]*>|<!--[\s\S]*?-->', re.I)
    if markup.search(decoded):
        parser = PlainText()
        for part in re.split('(' + markup.pattern + ')', decoded, flags=re.I):
            parser.feed(part if markup.fullmatch(part) else part.replace('&', '&amp;').replace('<', '&lt;'))
        parser.close()
        decoded = ''.join(parser.parts)
    text = decoded
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
        assert key not in works, f'Duplicate Hanson bibliography key: {key}'
        works[key] = item
        entries.append(item)

    for key, target in redirects.items():
        target_key = target.split(',')[0] + ' ' + target.split()[-1] if ',' in target else target
        if target_entry := works.get(target_key):
            works[key]['see_row'] = target_entry['row']
        works[key]['target'] = target_key

    variants = {'Cornell and Mathews 1982':'Cornell and Matthews 1982',
                'Carreras Monfort 1995-1996':'Carreras-Monfort 1995-1996',
                'Lepelley 1979-1981':'Lepelley 1979 and 1981',
                'Millett 1990: Table 6.5':'Millett 1990','Millett 1990: Table 4.4':'Millett 1990'}
    def resolve(token):
        entry = works.get(variants.get(token,token))
        if entry is None:
            return {'token':token,'match':'unresolved'}
        full = works.get(entry.get('target', entry['key']))
        if full is None:
            return {'token':token,'match':'unresolved'}
        return {'token':token,'match':'variant' if token in variants else 'exact',
                'source_row':entry['row'],'row':full['row'],'text':full['text'],
                **({'note':full['note']} if 'note' in full else {})}
    return entries, resolve


BIB_HEADER = re.compile(r'\s*@(\w+)\s*\{([^,]+),')
FIELD = re.compile(r'\s*([\w-]+)\s*=\s*')
PUBLIC_FIELDS = set('author editor year title journal booktitle volume pages doi url publisher number '
                    'address school institution edition series note'.split())

ACCENTS = dict(zip("'"+'\x60'+'^"~=.'+'uvHck', '\u0301\u0300\u0302\u0308\u0303\u0304\u0307\u0306\u030c\u030b\u0327\u0328'))
TEX = re.compile(r"""\\(?:([\'\x60^"~=\.uvHck])\s*\{([^\W\d_])\}|([\'\x60^"~=\.])([^\W\d_])|(ae|AE|oe|OE|ss|o|O|l|L|textless|textgreater)\b(?:\{\})?|([{}&%_#$:\\]))|([{}])""")
LETTERS = dict(zip('ae AE oe OE ss o O l L textless textgreater'.split(), 'æÆœŒßøØłŁ<>'))


def bib_display(value):
    def decode(match):
        accent, letter, bare_accent, bare_letter, command, escaped, group = match.groups()
        if accent or bare_accent:
            return unicodedata.normalize('NFC', (letter or bare_letter) + ACCENTS[accent or bare_accent])
        if group:
            return ''
        return LETTERS[command] if command else escaped
    return ' '.join(TEX.sub(decode, value).replace('---', '—').replace('--', '–').split())


def bibliography_entries(text):
    pos = 0
    entries = []
    while pos < len(text) and text[pos:].strip():
        header = BIB_HEADER.match(text, pos)
        if not header:
            raise ValueError(f'Invalid bibliography entry at offset {pos}')
        item = {'type': header[1], 'key': header[2].strip()}
        pos = header.end()
        while True:
            end = re.compile(r'\s*}').match(text, pos)
            if end:
                pos = end.end()
                break
            field = FIELD.match(text, pos)
            if not field:
                raise ValueError(f'Invalid field in {item["key"]} at offset {pos}')
            pos = field.end()
            opener = text[pos:pos+1]
            if opener in ('{', '"'):
                start = pos + 1
                pos = start
                depth = 0
                while pos < len(text):
                    char = text[pos]
                    if char == '\\':
                        pos += 2
                        continue
                    if depth == 0 and char == ('}' if opener == '{' else '"'):
                        break
                    depth += (char == '{') - (char == '}')
                    if depth < 0:
                        break
                    pos += 1
                if pos >= len(text) or depth != 0:
                    raise ValueError(f'Unterminated {field[1]} in {item["key"]} at offset {start}')
                value = text[start:pos]
                pos += 1
            else:
                bare = re.compile(r'[\w-]+').match(text, pos)
                if not bare:
                    raise ValueError(f'Missing {field[1]} in {item["key"]} at offset {pos}')
                value = bare[0]
                pos = bare.end()
            if field[1].lower() in PUBLIC_FIELDS:
                item[field[1].lower()] = bib_display(value)
            sep = re.compile(r'\s*(,|(?=}))\s*').match(text, pos)
            if not sep:
                raise ValueError(f'Expected comma or closing brace in {item["key"]} at offset {pos}')
            pos = sep.end()
        entries.append(item)
    return entries


def paragraph(node):
    controls = {'br': '\n', 'cr': '\n', 'tab': '\t'}
    return ''.join(n.text or '' if n.tag.endswith('}t') else controls.get(n.tag.split('}')[-1], '')
                   for n in node.iter())


def field_document(path):
    with zipfile.ZipFile(path) as archive:
        body = ET.fromstring(archive.read('word/document.xml')).find('{*}body')
    native = [{'paragraph': i, 'text': paragraph(p)} for i,p in enumerate(body.iterfind('.//{*}p'), 1) if paragraph(p)]
    def children(node):
        for child in node:
            if child.tag.endswith(('}sdt', '}sdtContent')):
                yield from children(child)
            else:
                yield child
    blocks = []
    for node in children(body):
        if node.tag.endswith('}p') and paragraph(node):
            blocks.append({'paragraph': paragraph(node)})
        elif node.tag.endswith('}tbl'):
            rows = []
            for row in children(node):
                if not row.tag.endswith('}tr'):
                    continue
                cells = []
                for cell in children(row):
                    if not cell.tag.endswith('}tc'):
                        continue
                    text = '\n'.join(paragraph(p) for p in children(cell) if p.tag.endswith('}p'))
                    span = cell.find('{*}tcPr/{*}gridSpan')
                    width = int(next(iter(span.attrib.values()))) if span is not None else 1
                    cells.append({'text': text, 'span': width} if width > 1 else text)
                rows.append(cells)
            blocks.append({'rows': rows})
    return native, blocks
