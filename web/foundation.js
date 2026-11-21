import { searchIndex } from './search.js';
import { element, renderDetail } from './details.js';

import { registry } from './layers.js';

const $=selector=>document.querySelector(selector);
const empty={type:'FeatureCollection',features:[]};

export function relationIndex(edges,byID) {
  const neighbors=new Map();
  for (const edge of edges) {
    if (!byID.has(edge.from)||!byID.has(edge.to)) continue;
    for (const [id,other] of [[edge.from,edge.to],[edge.to,edge.from]]) {
      if (!neighbors.has(id)) neighbors.set(id,[]);
      neighbors.get(id).push({other:byID.get(other),role:({'source-endpoint':'Origin','target-endpoint':'Destination'})[edge.role] || edge.role});
    }
  }
  return neighbors;
}

export async function mountFoundation(map,release,load,preferences={},persist=()=>{}) {
  const {datasets,groups}=registry(release);
  if (!datasets.length) return;
  const sources=new Map(datasets.map(d=>[d.id,d.label]));
  const files=groups.flatMap(g=>g.sources);
  const [catalog,edges,...collections]=await Promise.all(['catalog.json.gz','relations.json.gz',
    ...files.map(file=>file.id+'.geojson.gz')].map(load));
  const records=catalog.records.filter(r=>sources.has(r.source));
  const byID=new Map(records.map(r=>[r.id,r])), index=searchIndex(records);
  const neighbors=relationIndex(edges,byID);
  const contents=new Map(files.map((file,i)=>[file.id,collections[i]]));
  const styles=files.flatMap(file=>file.styles.map(style=>({...style,source:file.id})));
  const sourceGroup=new Map(groups.flatMap(group=>group.sources.map(source=>[source.id,group])));
  const state={...preferences};
  const visible=id=>state[sourceGroup.get(id)?.id]!==false;
  let selected, category='', overlap=[];
  const picker=$('#overlap-picker'), choices=$('#overlap-records');
  function matchesCategory(record) {
    return !category || !sourceGroup.get(record.layer)?.categoryFilter || record.category===category;
  }
  function highlight() {
    const shown=selected?.geometry && visible(selected.record.layer) && matchesCategory(selected.record);
    map.getSource('selected-record').setData(shown
      ? {type:'Feature',properties:{id:selected.record.id},geometry:selected.geometry} : empty);
  }
  function showPicker() {
    const hits=overlap.filter(record=>visible(record.layer) && matchesCategory(record));
    picker.hidden=hits.length<2;
    choices.replaceChildren();
    if (picker.hidden) return;
    $('#overlap-count').textContent=hits.length+' overlapping records at this location';
    for (const record of hits) {
      const button=element('button',record.label);
      button.dataset.record=record.id;
      button.append(element('small',sources.get(record.source)+' · '+(record.category || record.kind)));
      button.setAttribute('aria-pressed',String($('#record-panel').dataset.record===record.id));
      button.onclick=()=>select(record.id,null,true);
      choices.append(button);
    }
  }
  for (const file of files) map.addSource(file.id,{type:'geojson',data:contents.get(file.id)});
  // Draw point symbols above linework; picking has a separate explicit priority.
  for (const style of styles.toSorted((a,b)=>b.priority-a.priority)) {
    const {priority,...spec}=style;
    map.addLayer({...spec,layout:{visibility:visible(style.source)?'visible':'none'}});
  }
  map.addSource('selected-record',{type:'geojson',data:empty});
  map.addLayer({id:'selected-point',source:'selected-record',type:'circle',
    filter:['in',['geometry-type'],['literal',['Point','MultiPoint']]],
    paint:{'circle-radius':6,'circle-color':'#bf552a','circle-stroke-color':'#fff','circle-stroke-width':1}});
  map.addLayer({id:'selected-line',source:'selected-record',type:'line',
    filter:['in',['geometry-type'],['literal',['LineString','MultiLineString']]],
    paint:{'line-width':4,'line-color':'#bf552a'}});
  for (const group of groups) {
    const label=element('label'),input=element('input');
    input.type='checkbox'; input.checked=visible(group.sources[0].id); input.dataset.layer=group.id;
    const counts=group.sources.map(file=>contents.get(file.id).features.length.toLocaleString('en-US')+
      (file.unit?' '+file.unit:'')).join(' · ');
    label.append(input,document.createTextNode(' '+group.title+' ('+counts+')'));
    $('#atlas-layers').append(label);
    const legend=element('span'); legend.className='legend-group'; legend.dataset.group=group.id;
    legend.hidden=!input.checked;
    for (const [swatch,title] of group.legend) {
      const key=element('span'),mark=element('i'); mark.className='key-'+swatch;
      key.append(mark,document.createTextNode(title)); legend.append(key);
    }
    $('#layer-legend').append(legend);
    input.onchange=()=>{
      state[group.id]=input.checked;
      for (const file of group.sources) for (const style of file.styles) {
        map.setLayoutProperty(style.id,'visibility',input.checked?'visible':'none');
      }
      legend.hidden=!input.checked; highlight(); showPicker(); persist({...state});
    };
  }
  const cache=new Map(); let generation=0;
  async function select(id,focusRow,fromPicker=false) {
    const record=byID.get(id);
    if (!record) return;
    const turn=++generation, panel=$('#record-panel');
    panel.hidden=false; panel.dataset.record=id; delete panel.dataset.loaded;
    if (!fromPicker) overlap=[];
    showPicker();
    const body=$('#record-content'); body.replaceChildren(element('p','Loading record…'));
    selected=null; highlight();
    try {
      if (!cache.has(record.detail)) {
        cache.set(record.detail,load(record.detail));
        if (cache.size>6) cache.delete(cache.keys().next().value);
      }
      let shard;
      try { shard=await cache.get(record.detail); } catch (error) {cache.delete(record.detail); throw error;}
      if (turn!==generation) return;
      const detail=shard[id];
      body.replaceChildren(renderDetail(record,detail,neighbors.get(id)||[],select,focusRow));
      selected={record,geometry:detail.geometry}; highlight();
      if (!fromPicker && record.bbox) map.fitBounds([[record.bbox[0],record.bbox[1]],[record.bbox[2],record.bbox[3]]],{maxZoom:6,padding:40,duration:0});
      panel.dataset.loaded=id;
      if (focusRow) body.querySelector('.selected-reference')?.focus();
      else panel.scrollIntoView({block:'nearest'});
    } catch (error) {if (turn===generation) body.replaceChildren(element('p',error.message));}
  }
  $('#close-record').onclick=()=>{++generation; selected=null;overlap=[];showPicker();highlight();$('#record-panel').hidden=true;};
  const filter=$('#search-source');
  for (const [id,title] of sources) filter.add(new Option(title,id));
  const categoryFilter=$('#search-category');
  const categories=new Set(records.map(r=>r.category).filter(Boolean));
  categoryFilter.hidden=!categories.size;
  for (const name of [...categories].sort()) categoryFilter.add(new Option(name,name));
  let hits=[], shown=0;
  function more() {
    for (const {record,via} of hits.slice(shown,shown+25)) {
      const button=element('button',record.label.replace(/\s+/g,' ').trim());
      button.append(element('small',sources.get(record.source)+(via?' · title found via Pleiades alias':'')));
      button.dataset.record=record.id; button.onclick=()=>select(record.id);
      $('#search-results').append(button);
    }
    shown+=25; $('#more-results').hidden=shown>=hits.length;
  }
  function search() {
    hits=[...index.search($('#search').value,filter.value)].filter(hit=>!category || hit.record.category===category); shown=0;
    $('#search-results').replaceChildren(); $('#search-status').textContent=hits.length+' results'; more();
  }
  $('#search').oninput=filter.onchange=search; $('#more-results').onclick=more;
  categoryFilter.onchange=()=>{
    category=categoryFilter.value;
    for (const style of styles.filter(s=>sourceGroup.get(s.source).categoryFilter)) {
      const tests=[style.filter,category?['==',['get','category'],category]:null].filter(Boolean);
      map.setFilter(style.id,tests.length?['all',...tests]:null);
    }
    search(); highlight(); showPicker();
  };
  const priority=new Map(styles.map(style=>[style.id,style.priority]));
  map.on('click',event=>{
    const layers=styles.filter(style=>visible(style.source)).map(style=>style.id);
    const {x,y}=event.point;
    const features=layers.length?map.queryRenderedFeatures([[x-5,y-5],[x+5,y+5]],{layers}):[];
    const ordered=features.sort((a,b)=>priority.get(a.layer.id)-priority.get(b.layer.id)
      || String(a.properties.id).localeCompare(String(b.properties.id),'en'));
    const ids=new Set(ordered.map(f=>f.properties.id));
    overlap=[...ids].map(id=>byID.get(id)).filter(Boolean);
    if (overlap.length) select(overlap[0].id,null,true);
    else showPicker();
  });
  $('#foundation-controls').hidden=false;
}
