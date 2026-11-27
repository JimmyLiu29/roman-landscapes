"""Small synthetic cases for the atlas adapters and offline entry points."""
from contextlib import chdir
import copy
import csv
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import foundation
import inputs
from atlas import economy, fields, history, model
from preprocess import output_directory, release_id


class AtlasTests(unittest.TestCase):
    def test_acquisition_scope_and_argument_forwarding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for d in ('scripts','bin','data','.venv/bin'):
                (root/d).mkdir(parents=True)
            shutil.copy2(ROOT/'bin/acquire', root/'bin/acquire')
            shutil.copyfile(ROOT/'scripts/inputs.py',root/'scripts/inputs.py')
            (root/'.venv/bin/python').symlink_to(sys.executable)
            raw = b'Synthetic input'
            lock = hashlib.sha256(raw).hexdigest()
            records = []
            for name in sorted(inputs.FOUNDATION | inputs.ADDITIONS):
                record = dict(id=name, path='data/'+name, sha256=lock, bytes=len(raw),
                              landing_url='https://example.org/snapshot', url='unused')
                if name not in inputs.FOUNDATION:
                    record['acquisition_mode'] = 'pinned_local_snapshot'
                else:
                    (root/record['path']).write_bytes(raw)
                records.append(record)
            (root/'data/source-manifest.json').write_text(json.dumps({'schema':1, 'sources':records}))
            (root/'data/oxford-water').write_bytes(b'corrupted')
            for args in ([],['--scope','foundation']):
                self.assertEqual(subprocess.run([root/'bin/acquire',*args],capture_output=True).returncode,0)
            result = subprocess.run([root/'bin/acquire','--scope','all'],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertTrue(all('data/'+name in result.stderr for name in inputs.ADDITIONS))
            self.assertIn(lock,result.stderr)
            with patch('urllib.request.urlopen') as network, self.assertRaises(ValueError):
                inputs.acquire('all',root=root,download=True)
            network.assert_not_called()

    def test_wreck_repair_requires_actual_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'fiction.xlsx'
            path.write_bytes(b'Unrelated synthetic workbook')
            with self.assertRaisesRegex(AssertionError,'column repair'):
                economy.wreck_rows({'path':str(path),'sha256':'eaf55526903599c0ef4ca10bc34daf942317f24649f6a253ab8b56876338bc2c'})

    def test_field_modes(self):
        for text in ('re<p>ublica','Ptolem<a>ios','<a>ugusti','<i>mp(erator)','q<u>i','A &amp; B','a\n b'):
            row={'title':text}
            self.assertEqual(fields.clean_fields(row)['title'],' '.join(text.split()))
            self.assertEqual(fields.clean_fields(row,frozenset(row)),foundation.plain_fields(row))
        self.assertEqual(fields.clean_fields({'a':'<b>Test</b>'},{'a'}),{'a':'Test'})

    def test_gazetteer_readings_match_foundation(self):
        class Capture:
            def __init__(self):
                self.ids=set()
                self.details={}
            def add(self,key,label,source,kind,native,geometry,**kwargs):
                self.ids.add(key)
                self.details[key]={}
                return {},self.details[key]
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            place={'id':'1','title':'<b>Site</b>','representative_longitude':'20','representative_latitude':'35'}
            name=dict(id='2',place_id='1',title='<p>Example</p>',attested_form='',name_type='undefined',
                      romanized_form_1='',romanized_form_2='',romanized_form_3='')
            for filename,row in [('places.csv',place),('pleiades-v4.1-names.csv',name)]:
                with (root/filename).open('w',newline='') as f:
                    writer=csv.DictWriter(f,fieldnames=row)
                    writer.writeheader()
                    writer.writerow(row)
            a,b=Capture(),Capture()
            record=dict(path='places.csv',assets=[dict(path='pleiades-v4.1-names.csv')])
            with patch.object(foundation,'ROOT',root):
                foundation.gazetteer(a,copy.deepcopy(record))
                model.gazetteer(b,copy.deepcopy(record),set())
            self.assertEqual(a.details,b.details)

    def test_coordinate_priority(self):
        for x,y,expected in [(None,20,'missing_coordinate'),('nan',21,'missing_coordinate'),
                ('0.0','0','placeholder_zero'),(80,33,'outside_map_bounds'),(12,34,'mapped')]:
            self.assertEqual(fields.coordinate_status(x,y),expected)
            self.assertEqual(economy.point(x,y),{'type':'Point','coordinates':[12.,34.]} if expected=='mapped' else None)

    def test_date_boundaries(self):
        for source,key,n,sentinel in [('itinere','Lower_Date',0,'uncertain_zero'),('itinere','Up_Date_E',9999,'missing_9999'),
                ('oxford-presses','post_0',-999,'unspecified_bound'),('oxford-presses','ante_0',999,'unspecified_bound'),
                ('oxford-karanis','transyear','42339','spreadsheet_date_coercion')]:
            item,=fields.source_dates({key:n},[key],source)
            self.assertEqual((item['raw'],item['year'],item['sentinel']),(n,None,sentinel))
        item,=fields.source_dates({'ante_0':'9999'},['ante_0'],'oxford-presses')
        self.assertEqual((item['display'],item['raw'],item['year']),('9999','9999',None))
        stmt={'id':'s','mainsnak':{'datavalue':{'value':{'time':'+0000-01-01T00:00:00Z','precision':11,'calendarmodel':'Q1985786'}}}}
        self.assertEqual(history.time_item('P585',stmt)['display'],'0 (source value)')

    def test_parallel_currency_fields_and_water_damage(self):
        row={'Corrected into dr. decimals A':'12','Corrected into dr. decimals A [Z]':'3'}
        self.assertEqual(fields.corrected_drachma(row),row)
        self.assertEqual(fields.clean_fields({'word':'?? <a>st'}),{'word':'?? <a>st'})
        self.assertIn('water_lost_greek', model.NOTICES['economy_water_reference'])

    def test_identity_covers_semantics(self):
        desc=dict(schema=1,app_schema=2,archives=[{'collection_notices':[]}],datasets=[{'group':'economy'}],files=[])
        original=release_id(desc)
        for key in ('app_schema','archives','datasets'):
            changed=copy.deepcopy(desc)
            if key=='app_schema': changed[key]=3
            if key=='archives': changed[key][0]['collection_notices'].append('Notice')
            if key=='datasets': changed[key][0]['group']='foundation'
            self.assertNotEqual(release_id(changed),original)

    def test_relative_output_and_protected_tree(self):
        with tempfile.TemporaryDirectory() as tmp, chdir(tmp):
            self.assertEqual(output_directory('candidate'), Path(tmp).resolve()/'candidate')
        with self.assertRaises(ValueError):
            output_directory(ROOT/'.state'/'candidate')
