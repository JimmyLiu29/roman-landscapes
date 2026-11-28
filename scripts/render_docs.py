"""Render controlled Markdown: headings 2-4, paragraphs, lists, rules, tables,
emphasis, strong emphasis, inline code and absolute HTTP(S) links.
"""
import argparse
import gzip
from html import escape
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / 'web/index.html'
TOKEN = re.compile(r'`([^`]+)`|\*\*(.+?)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)')


def inline(text):
    parts = []
    pos = 0
    for m in TOKEN.finditer(text):
        parts.append(plain(text[pos:m.start()]))
        code, strong, em, label, url = m.groups()
        if url:
            target = urlsplit(url)
            if target.scheme not in ('https', 'http') or not target.hostname or any(c.isspace() for c in url):
                raise ValueError('Expected an absolute HTTP(S) link')
            parts.append(f'<a href="{escape(url, quote=True)}" target="_blank" rel="noopener noreferrer">{inline(label)}</a>')
        elif code is not None:
            parts.append('<code>'+escape(code)+'</code>')
        else:
            tag = 'strong' if strong is not None else 'em'
            parts.append(f'<{tag}>{inline(strong or em)}</{tag}>')
        pos = m.end()
    return ''.join(parts) + plain(text[pos:])


def plain(text):
    if re.search(r'[`*\[\]]|~~|(?<!\w)_(?=\w)', text):
        raise ValueError('Unsupported inline markup: '+text)
    return escape(text)


def article(name, source):
    lines = source.splitlines()
    chapters, body = [], []
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line:
            continue
        if line == '---':
            body.append('<hr>')
            continue
        heading = re.fullmatch(r'(#{2,4}) (.+)', line)
        if heading:
            level = len(heading[1])
            title = inline(heading[2])
            if level == 3:
                anchor = f'{name}-chapter-{len(chapters)+1}'
                chapters.append((anchor,title))
                body.append(f'<h3 id="{anchor}" tabindex="-1">{title}</h3>')
            else:
                body.append(f'<h{level}>{title}</h{level}>')
            continue
        if line.startswith('|'):
            def cells(row):
                if not row.endswith('|'):
                    raise ValueError('Incomplete table row')
                return [cell.strip() for cell in row[1:-1].split('|')]
            header = cells(line)
            if i >= len(lines) or not all(re.fullmatch(r':?-{3,}:?', c) for c in cells(lines[i])) or len(cells(lines[i])) != len(header):
                raise ValueError('Missing table divider')
            i += 1
            def row(items, tag):
                return '<tr>'+''.join(f'<{tag}>{inline(c)}</{tag}>' for c in items)+'</tr>'
            body.append('<table>'+row(header,'th'))
            while i < len(lines) and lines[i].startswith('|'):
                items = cells(lines[i])
                if len(items) != len(header):
                    raise ValueError('Inconsistent table columns')
                body.append(row(items,'td'))
                i += 1
            body.append('</table>')
            continue
        item = re.match(r'(-|\d+\.) (.+)', line)
        if item:
            tag = 'ul' if item[1]=='-' else 'ol'
            pattern = r'- (.+)' if tag=='ul' else r'\d+\. (.+)'
            body.append('<'+tag+'>')
            i -= 1
            while i < len(lines) and (entry := re.fullmatch(pattern, lines[i])):
                body.append('<li>'+inline(entry[1])+'</li>')
                i += 1
            body.append('</'+tag+'>')
            continue
        if re.match(r'[\s#>+!~]|-{2,}|={2,}', line):
            raise ValueError('Unsupported Markdown block: '+line)
        body.append('<p>'+inline(line)+'</p>')
    if not chapters or not body[0].startswith('<h2>'):
        raise ValueError('Missing guide headings')
    nav = ' '.join(f'<a href="#{anchor}">{title}</a>' for anchor,title in chapters)
    return '\n'.join([f'<article id="guide-{name}" hidden>', body[0], f'<nav aria-label="Chapters">{nav}</nav>',
                      '<div class="guide-text">', *body[1:], '</div>', '</article>'])


def page():
    html = PAGE.read_text()
    start = html.index('<article id="guide-methods"')
    end = html.index('</dialog>', start)
    guides = [article(name, (ROOT/'docs'/filename).read_text()) for name,filename in
              [('methods','about-methods.md'), ('datasets','datasets.md')]]
    return html[:start]+'\n'.join(guides)+'\n'+html[end:]


def check(directory):
    html = page()
    assert html == PAGE.read_text(), 'Guide HTML differs from its Markdown sources'
    dialog = html.split('<dialog id="guide-dialog"',1)[1].split('</dialog>',1)[0]
    anchors = re.findall(r'<h3 id="([^"]+)" tabindex="-1">', dialog)
    links = re.findall(r'<a href="#([^"]+)">', dialog)
    assert anchors == links and len(set(anchors)) == len(anchors)
    assert sum(x.startswith('datasets-chapter-') for x in anchors) == 13
    release = json.loads((directory/'release.json').read_bytes())
    pack = directory/'packs'/release['id']
    sources = json.loads((pack/'sources.json').read_bytes())['sources']
    with gzip.open(pack/'catalog.json.gz') as f:
        rows = json.load(f)['records']
    people = [r['layers'] for r in rows if r['render_kind']=='history_person']
    with gzip.open(pack/'relations.json.gz') as f:
        towns = {e['to'] for e in json.load(f) if e['group'] in ('event_town','person_activity_town','person_biography_town')}
    counts = [len(rows), len(sources), sum(s['accounting'].get('evidence_records',0) for s in sources),
              sum(r['render_kind']=='history_event' for r in rows),len(people),sum('people' in x for x in people),
              sum('people-biography' in x for x in people),sum(len(x)==2 for x in people),
              people.count(['people-biography']),len(towns),release['bytes']]
    assert counts == [75223,16,23385,324,1208,414,944,150,794,383,57448450], counts
    for name in ('README.md','docs/datasets.md','docs/data-model.md','web/index.html'):
        text = (ROOT/name).read_text()
        for count in counts:
            assert re.search(r'(?<![\d,])'+f'{count:,}'+r'(?![\d,])',text), (name,count)
        assert f"{release['bytes']/2**20:.1f} MiB / {release['bytes']/10**6:.2f} MB" in text


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.check:
        check(ROOT/'dist')
        print('Verified guide content, chapter focus targets and atlas inventory.')
    else:
        PAGE.write_text(page())
