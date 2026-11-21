"""Regression cases from the source formats used by Roman Landscapes."""
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from readings import bibliography_entries, field_document, plain_text
from formats import xlsx_sheets, table_rows
from foundation import source_date


class ParserTests(unittest.TestCase):
    def test_bibtex_display(self):
        bib = r'''@book{x, title="M{\"u}ller, \v{z}, \ae{} \{text\} \& \% \_ \# \$ --- --",
                  address={Oxford}, note="A {nested} title"}'''
        item, = bibliography_entries(bib)
        self.assertEqual(item['title'], 'Müller, ž, æ {text} & % _ # $ — –')
        self.assertEqual(item['address'], 'Oxford')
        self.assertEqual(item['note'], 'A nested title')

    def test_truncated(self):
        for bad in ['{unclosed', '"unclosed', '', '{ok} next={bad}']:
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'broken'):
                bibliography_entries('@book{broken, title='+bad)

    def test_locked_bibliography(self):
        path = ROOT / 'data/raw/itinere/Itiner-e bibliography.bib'
        entries = bibliography_entries(path.read_text(encoding='utf-8'))
        self.assertEqual(len(entries), 627)
        self.assertFalse(any('\\' in v for entry in entries for v in entry.values()))

    def test_docx_order_and_spans(self):
        body = '''<w:sdt><w:sdtContent><w:p><w:r><w:t>A</w:t><w:br/><w:t>B</w:t>
        <w:tab/><w:t>C</w:t><w:cr/><w:t>D</w:t></w:r></w:p></w:sdtContent></w:sdt>
        <w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>cell</w:t>
        </w:r></w:p></w:tc></w:tr></w:tbl>'''
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'test.docx'
            with ZipFile(path, 'w') as archive:
                archive.writestr('word/document.xml', '<w:document xmlns:w="doc"><w:body>'+body+'</w:body></w:document>')
            _, blocks = field_document(path)
        self.assertEqual(blocks, [{'paragraph':'A\nB\tC\nD'}, {'rows':[[{'text':'cell','span':2}]]}])

    def test_xlsx(self):
        ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
        rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'test.xlsx'
            with ZipFile(path,'w') as archive:
                archive.writestr('xl/workbook.xml', f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets><sheet name="s" r:id="r1"/></sheets></workbook>')
                archive.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="s.xml"/></Relationships>')
                archive.writestr('xl/sharedStrings.xml', f'<sst xmlns="{ns}"><si><r><t>A</t></r><rPh><t>ignore</t></rPh><r><t>B</t></r></si></sst>')
                archive.writestr('xl/s.xml', f'<worksheet xmlns="{ns}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>')
            self.assertEqual(xlsx_sheets(path)['s'][0]['cells'], {'A':'AB'})
        rows = [{'row':1,'cells':dict(A='x',B='x [C]',C='x',D='source_row')},
                {'row':2,'cells':dict(A='a',B='b',C='c',D='d')}]
        self.assertEqual(table_rows(rows)[0], {'source_row':2,'x':'a','x [C]':'b','x [C] [C]':'c','source_row [D]':'d'})

    def test_historical_text(self):
        for text in ('<AD 100>', '<AD 100 ...>'):
            self.assertEqual(plain_text('<p>'+text+' &amp;amp;</p>'),text+' &amp;')
            self.assertEqual(plain_text(text),text)
        self.assertEqual(plain_text('&lt;b&gt;Roma&lt;/b&gt;'),'Roma')

    def test_date_sentinels(self):
        for value in (0,0.0,9999,'0','9999','NULL','',None):
            self.assertIsNone(source_date(value))
        self.assertEqual(source_date(-44), -44)
