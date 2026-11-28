"""Make a deterministic miniature atlas from invented records and a drawn raster."""
from collections import defaultdict
import json
from pathlib import Path
import shutil
import struct
import sys
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from pipeline import digest, shell_sources, worker_text
from preprocess import release_id, write


def relief():
    def chunk(name, body):
        return struct.pack('>I',len(body))+name+body+struct.pack('>I',zlib.crc32(name+body))
    pixels = b''.join(b'\0'+bytes([145+y//4,158+y//5,130])*256 for y in range(256))
    png = (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',256,256,8,2,0,0,0))
           +chunk(b'IDAT',zlib.compress(pixels,9))+chunk(b'IEND',b''))
    def varint(n):
        data=bytearray()
        while n>=128:
            data.append((n&127)|128)
            n >>= 7
        return bytes(data)+bytes([n])
    directory=b'\x01\x00\x01'+varint(len(png))+b'\x01'
    start=127+len(directory)
    header=b'PMTiles\x03'+struct.pack('<11Q',127,len(directory),start,2,0,0,start+2,len(png),1,1,1)
    header+=bytes([1,1,1,2,0,0])+struct.pack('<4iB2i',-1800000000,-850000000,1800000000,850000000,0,0,0)
    return header+directory+b'{}'+png


def build(out):
    stage=out/'packs/stage'
    stage.mkdir(parents=True)
    sources=['hanson-cities','itinere','orbis-maritime','pleiades','oxford-mines','oxford-shipwrecks',
             'raad','oxford-karanis','oxford-presses','oxford-quarries','oxford-water','wikidata-history']
    layers={k:[] for k in ('settlements','roads','maritime','ports','economy','events','people','people-biography')}
    rows, shards, edges=[], defaultdict(dict), []
    point={'type':'Point','coordinates':[12,42]}
    line={'type':'LineString','coordinates':[[11,41],[12,42]]}
    categories=['Mining and metals','Shipwrecks and cargo','Amphorae and commodities','Fiscal records','Oil and wine production']
    def add(source,kind,key,label,located=(),aliases=(),category=None,archive=False,**detail):
        name=f'details-{source}-000.json.gz'
        row=dict(id=key,label=label,kind=kind,render_kind=kind,source=source,source_order=len(shards[name])+1,
                 layers=list(located),detail=name,aliases=list(aliases))
        d=dict(id=key,native={'Example':'Invented demonstration'},render_kind=kind,geometry_status='archive_only',**detail)
        if category: row['category']=category
        if archive: row['archive']=source
        for layer in located:
            geom=line if layer in ('maritime','roads') else point
            geom={'type':'MultiPoint','coordinates':[[12,42],[14,44]]} if layer=='people-biography' else geom
            oid=key+'#'+layer
            props=dict(record_id=key,occurrence_id=oid,rank='1',t='overseas',certainty='Certain',label=label)
            if category: props['category']=category
            layers[layer].append(dict(type='Feature',id=oid,properties=props,geometry=geom))
            d.setdefault('occurrences',{})[layer]=dict(geometry=geom,position_basis='source-coordinate')
            d.setdefault('geometry',geom)
            d['geometry_status']='mapped'
            row['bbox']=[11,41,14,44] if len(located)>1 else [12,42,12,42]
        if len(located)>1: row['layer_bboxes']={located[0]:[12,42,12,42],located[1]:[12,42,14,44]}
        rows.append(row);shards[name][key]=d
        return row,d
    add(sources[0],'hanson_settlement','demo:town','Roma',['settlements'],['Rhome','Town-A'],citations=[],tables={})
    add(sources[1],'itinere_road','demo:road','Test road',['roads'],['3'],date_bounds={},date_margins={})
    add(sources[0],'hanson_bibliography','hanson:bibliography','Sample city bibliography',
        entries=[dict(text='An invented citation',row=1)])
    _,unmatched=add(sources[0],'hanson_unmatched','hanson:unmatched','Unidentified example')
    unmatched['native']=[{'Example':'Unassigned demonstration entry'}]
    add(sources[1],'itinere_bibliography','itinere:bibliography','Sample road bibliography',
        entries=[dict(title='Test reference',key='demo')])
    add(sources[1],'itinere_fields','itinere:fields','Example field definitions',
        blocks=[dict(paragraph='Demonstration of a source definition.')])
    add(sources[2],'orbis_route','demo:route','Test route',['maritime'])
    add(sources[2],'orbis_place','demo:port','Test port',['ports'])
    add(sources[3],'pleiades_place','pleiades:114765','Test gazetteer',names=[],reading={'Title':'Test gazetteer'})
    for i,(key,kind) in enumerate([('mine','mine'),('wreck','shipwreck'),('site','raad_assemblage'),('anchor','karanis_archive'),('press','press_group')]):
        source=sources[4+i]
        row,d=add(source,'economy_'+kind,'karanis:archive' if i==3 else 'demo:'+key,'Example '+key,['economy'],
                  ['7','Demo-'+key],categories[i],summary={'Evidence':'Invented example'})
        if i==3: d.update(archive_source=source,crosswalk={'Basis':'Demonstration association'})
        if i==1: d['tables']={'Amphorae (Wreck ID)':[{'Tag':'Model A'}],'Site objects (objloc = locid)':[{'Tag':'Model B'}]}
    add(sources[6],'economy_raad_observation','demo:observation','Example observation',
        summary={'Test quantity':'2'},category=categories[2])
    add(sources[6],'economy_raad_type','demo:type','Example vessel type',
        tables={'Native type concordance':[{'Example type':'Sample A'}]})
    add(sources[5],'source_note','shipwrecks:unmatched','Unmatched demonstration objects')
    shards['details-oxford-shipwrecks-000.json.gz']['shipwrecks:unmatched']['native']=[{'Tag':'Unassigned '+str(i)} for i in range(3)]
    def relate(start,end,group):
        edges.append({'from':start,'to':end,'group':group,'role':'documented association','source':'demo','basis':'Explicit demonstration link'})
    relate('demo:site','pleiades:114765','economic_place')
    archives=[]
    for source,kind in [('oxford-karanis','karanis_transaction'),('oxford-quarries','quarry'),('oxford-water','water_reference')]:
        notice=dict(code='water_lost_greek' if source=='oxford-water' else 'collection_limit',message='Demonstration source limitation.')
        archives.append(dict(id=source,label=source,record_count=27,anchor_id='karanis:archive' if source=='oxford-karanis' else None,
                             collection_notices=[notice],member_browse_mode='archive'))
        for i in range(27):
            _,d=add(source,'economy_'+kind,source+':demo:'+str(i),'Example '+str(100-i),aliases=['P.Mich. Demo' if i==0 else str(i)],
                    archive=True,summary={'Evidence':'Invented example'},warnings=[notice])
            if kind=='karanis_transaction':
                d['summary'].update({'Corrected drachma A':'1','Corrected drachma B':'2'})
                relate(d['id'],'karanis:archive','archive_member')
        if source=='oxford-water':add(source,'economy_document_place','demo:document','Test document place')
    proof=dict(Entity='Q900001',Revision=18,Property='P585',Statement={'id':'example','rank':'normal',
               'mainsnak':{'snaktype':'somevalue'},'qualifiers':{},'references':[]})
    for key,label,kind,loc in [('Q900001','Actium','history_event',['events']),('Q1048','Demo person','history_person',['people','people-biography']),
                               ('Q1407','Second demo person','history_person',['people-biography'])]:
        _,d=add(sources[-1],kind,'wikidata:'+key,label,loc,[key],summary={'Role':'Test'},
                source_url='https://example.org/history',history_links=[dict(role='associated town',node='demo:town',basis='Test',statement_evidence=[proof])])
        relate(d['id'],'demo:town','event_town' if kind=='history_event' else 'person_biography_town')
        if key=='Q1048':
            d['dated_supporting_events']=[dict(event_label='Unmapped sample event',event_qid='Q900002',event_revision=21,
                role='participant',event_record_id=None,dates=[],association_statement=proof,date_statements={'P585':[proof['Statement']]})]
            relate(d['id'],'wikidata:Q900001','person_event')
    for name,items in shards.items(): write(stage/name,items)
    for layer,items in layers.items():write(stage/(layer+'.geojson.gz'),dict(type='FeatureCollection',features=items))
    for name in ('land','ocean','coast','rivers','lakes'):
        write(stage/(name+'.geojson'),dict(type='FeatureCollection',features=[]))
    (stage/'relief.pmtiles').write_bytes(relief())
    write(stage/'catalog.json.gz',dict(schema=2,records=rows)); write(stage/'relations.json.gz',edges)
    physical=['natural-earth-'+k for k in ('relief','land','rivers','lakes')]
    write(stage/'sources.json',{'sources':[dict(id=k,label=k,citation='Demonstration source',terms='Example terms',
        terms_url='https://example.org/terms',landing_url='https://example.org/source',version='1',limitations=['Invented evidence']) for k in [*physical,*sources]]})
    files=[dict(name=f.name,bytes=f.stat().st_size,sha256=digest(f),kind='gzip-json' if f.suffix=='.gz' else 'archive' if f.suffix=='.pmtiles' else 'json') for f in sorted(stage.iterdir())]
    datasets=[dict(id=k,label=k,group='foundation' if i<4 else 'history' if i==11 else 'economy',archive_only=i in (9,10)) for i,k in enumerate(sources)]
    desc=dict(schema=1,app_schema=2,files=files,scope=['simple-base','natural-base','source-credits',*sources],
              datasets=datasets,archives=archives,bounds=[-17,15,55,63],view_bounds=[-27,8,65,67],tile_zoom=[0,0],view_zoom=[1,7])
    version=release_id(desc);stage.rename(stage.with_name(version))
    write(out/'release.json',{**desc,'id':version,'bytes':sum(f['bytes'] for f in files),
        'files':[{'path':f"packs/{version}/{f['name']}",**{k:v for k,v in f.items() if k!='name'}} for f in files]})
    shell=shell_sources()
    for name,source in shell.items():
        target=out/name;target.parent.mkdir(exist_ok=True,parents=True);shutil.copyfile(source,target)
    (out/'sw.js').write_text(worker_text(out,shell))


if __name__=='__main__':
    build(Path(sys.argv[1]))
