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
  // Earlier saved packs already contain these exact native fields in their offline detail shards.
  for (const [layer,field,native] of [['settlements','rank','Barrington Atlas Rank'],['maritime','t','t']]) {
    const missing=new Map();
    for(const {properties} of contents.get(layer)?.features || []) {
      if (field in properties) continue;
      const name=byID.get(properties.id).detail;
      if (!missing.has(name)) missing.set(name,[]);
      missing.get(name).push(properties);
    }
    for(const [name,items] of missing) {
      const shard=await load(name);
      for(const props of items) props[field]=shard[props.id].native[native];
    }
  }
  const attributes=new Map(collections.flatMap(fc=>fc.features.map(f=>[f.properties.id,f.properties])));
  const state={...preferences,tiers:{...preferences?.tiers}};
  if (state.tiers.maritime==='primary') state.tiers.maritime='overseas-ferry';
  for(const g of groups.filter(g=>g.tier)) {
    if(!g.tier.options.some(o=>o.id===state.tiers[g.id])) state.tiers[g.id]=g.tier.initial;
  }
  const sublayers=new Set(files.filter(f=>f.switchLabel).map(f=>f.id));
  const visible=id=>state[sourceGroup.get(id)?.id]!==false && (!sublayers.has(id) || state[id]===true);
  const currentTier=new Map();
  function effective(group) {
    if (!group?.tier) return;
    const mode=state.tiers[group.id];
    const value=mode==='auto'?group.tier.atZoom(map.getZoom()):mode;
    return group.tier.options.find(option=>option.id===value);
  }
  function allowed(layer,props) {
    const group=sourceGroup.get(layer);
    if (!visible(layer) || (category && group?.categoryFilter && props?.category!==category)) return false;
    const values=currentTier.get(layer)?.values;
    return !values || values.includes(props?.[group.tier.field]);
  }
  let selected, category='', overlap=[];
  const picker=$('#overlap-picker'), choices=$('#overlap-records');
  let highlighted=null;
  function highlight() {
    const shown=selected?.geometry && (!selected.record.layer || allowed(selected.record.layer,attributes.get(selected.record.id)));
    const id=shown ? selected.record.id : null;
    if (id===highlighted) return;
    highlighted=id;
    map.getSource('selected-record').setData(shown
      ? {type:'Feature',properties:{id:selected.record.id},geometry:selected.geometry} : empty);
  }
  function showPicker() {
    const hits=overlap.filter(record=>allowed(record.layer,attributes.get(record.id)));
    picker.hidden=hits.length<2;
    choices.replaceChildren();
    if (picker.hidden) return;
    $('#overlap-count').textContent=hits.length+' overlapping records at this location';
    for (const record of hits) {
      const button=element('button',record.label);
      button.dataset.record=record.id;
      button.append(element('small',sources.get(record.source)+' · '+(record.category || record.kind)));
      button.setAttribute('aria-pressed',String($('#record-panel').dataset.record===record.id));
      button.onclick=()=>select(record.id,null,'picker');
      choices.append(button);
    }
  }
  for (const file of files) map.addSource(file.id,{type:'geojson',data:contents.get(file.id)});
  // Draw point symbols above linework; picking has a separate explicit priority.
  for (const style of styles.toSorted((a,b)=>b.priority-a.priority)) {
    const {priority,...spec}=style;
    map.addLayer({...spec,layout:{...spec.layout,visibility:visible(style.source)?'visible':'none'}});
  }
  map.addSource('selected-record',{type:'geojson',data:empty});
  map.addLayer({id:'selected-point',source:'selected-record',type:'circle',
    filter:['in',['geometry-type'],['literal',['Point','MultiPoint']]],
    paint:{'circle-radius':6,'circle-color':'#bf552a','circle-stroke-color':'#fff','circle-stroke-width':1}});
  map.addLayer({id:'selected-line',source:'selected-record',type:'line',
    filter:['in',['geometry-type'],['literal',['LineString','MultiLineString']]],
    paint:{'line-width':4,'line-color':'#bf552a'}});
  const controls=new Map(), applied=new Map();
  function refresh() {
    for (const group of groups) {
      const ui=controls.get(group.id), choice=effective(group);
      currentTier.set(group.id,choice);
      const counts=group.sources.map(file=>{
        const available=contents.get(file.id).features;
        const count=visible(file.id) ? available.filter(f=>allowed(file.id,f.properties)).length : 0;
        return number(count)+(file.unit?' '+file.unit:'');
      });
      ui.count.textContent=' ('+counts.join(' · ')+')';
      ui.legend.hidden=state[group.id]===false;
      if(ui.select) ui.select.disabled=!ui.input.checked;
      if(ui.sub) ui.sub.disabled=!ui.input.checked;
      for(const {key,values,source} of ui.keys) {
        key.hidden=!visible(source) || Boolean(values && choice?.values && !values.some(v=>choice.values.includes(v)));
      }
    }
    for (const style of styles) {
      const group=sourceGroup.get(style.source);
      const choice=currentTier.get(style.source);
      const categoryValue=group.categoryFilter?category:'';
      const visibility=visible(style.source)?'visible':'none';
      const previous=applied.get(style.id);
      if (!previous || previous.choice!==choice || previous.categoryValue!==categoryValue) {
        const conditions=[style.filter, choice?.values && ['in',['get',group.tier.field],['literal',choice.values]],
          categoryValue && ['==',['get','category'],categoryValue]].filter(Boolean);
        map.setFilter(style.id, conditions.length>1?['all',...conditions]:conditions[0] || null);
      }
      if (previous?.visibility!==visibility) map.setLayoutProperty(style.id,'visibility',visibility);
      applied.set(style.id,{choice,categoryValue,visibility});
    }
    clearHover(); highlight(); showPicker();
  }
  function save() {refresh(); persist({...state,tiers:{...state.tiers}});}
  const number=n=>n.toLocaleString('en-US');
  for (const group of groups) {
    const row=element('div'), label=element('label'), input=element('input'), count=element('span');
    row.className='layer-control'; count.dataset.count=group.id;
    input.type='checkbox'; input.checked=state[group.id]!==false; input.dataset.layer=group.id;
    label.append(input,document.createTextNode(' '+group.title),count);
    row.append(label); $('#atlas-layers').append(row);
    const legend=element('span'); legend.className='legend-group'; legend.dataset.group=group.id;
    const keys=group.legend.map(([swatch,title,values,source=group.id])=>{
      const key=element('span'),mark=element('i'); mark.className='key-'+swatch;
      key.append(mark,document.createTextNode(title)); legend.append(key);
      return {key,values,source};
    });
    $('#layer-legend').append(legend);
    const ui={input,count,legend,keys}; controls.set(group.id,ui);
    input.onchange=()=>{state[group.id]=input.checked;save();};
    if(group.tier) {
      const select=element('select'); select.dataset.tier=group.id;
      select.setAttribute('aria-label',group.title+' detail');
      const features=contents.get(group.id).features;
      for(const option of group.tier.options) {
        const n=option.values?features.filter(f=>option.values.includes(f.properties[group.tier.field])).length:features.length;
        select.add(new Option(option.label+(option.id==='auto'?'':' ('+number(n)+')'),option.id));
      }
      select.value=state.tiers[group.id]; ui.select=select; row.append(select);
      select.onchange=()=>{state.tiers[group.id]=select.value;save();};
    }
    for(const file of group.sources.filter(file=>file.switchLabel)) {
      const sub=element('input'), name=element('label'); name.className='layer-sub';
      sub.type='checkbox'; sub.checked=state[file.id]===true; sub.dataset.sublayer=file.id;
      name.append(sub,document.createTextNode(' '+file.switchLabel+' ('+number(contents.get(file.id).features.length)+')'));
      ui.sub=sub; row.append(name);
      sub.onchange=()=>{state[file.id]=sub.checked;save();};
    }
  }
  const cache=new Map(); let generation=0;
  async function select(id,focusRow,origin='search') {
    const record=byID.get(id);
    if (!record) return;
    const turn=++generation, panel=$('#record-panel');
    panel.hidden=false; panel.dataset.record=id; delete panel.dataset.loaded;
    const locate=origin==='search' || origin==='relation';
    if (locate) overlap=[];
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
      body.replaceChildren(renderDetail(record,detail,neighbors.get(id)||[],(other,row)=>select(other,row,'relation'),focusRow));
      selected={record,geometry:detail.geometry}; highlight();
      if (locate && record.bbox) map.fitBounds([[record.bbox[0],record.bbox[1]],[record.bbox[2],record.bbox[3]]],{maxZoom:6,padding:40,duration:0});
      panel.dataset.loaded=id;
      if (focusRow) body.querySelector('.selected-reference')?.focus();
      else if (locate) panel.scrollIntoView({block:'nearest'});
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
  categoryFilter.onchange=()=>{category=categoryFilter.value; search(); refresh();};
  const priority=new Map(styles.map(style=>[style.id,style.priority]));
  function hitsAt(point) {
    const layers=styles.filter(style=>visible(style.source)).map(style=>style.id);
    if (!layers.length) return [];
    const {x,y}=point, candidates=new Map();
    for (const f of map.queryRenderedFeatures([[x-5,y-5],[x+5,y+5]],{layers})) {
      const id=f.properties.id, record=byID.get(id);
      if (candidates.has(id) || !record || !allowed(f.source,f.properties)) continue;
      const center=f.layer.type==='circle' && f.geometry.type==='Point'?map.project(f.geometry.coordinates):null;
      const rank=Number(f.properties.rank);
      candidates.set(id,{record,priority:priority.get(f.layer.id),rank:rank>0?rank:Infinity,
        distance:center?Math.hypot(center.x-x,center.y-y):0});
    }
    return [...candidates.values()].sort((a,b)=>a.priority-b.priority || a.rank-b.rank ||
      a.distance-b.distance || a.record.id.localeCompare(b.record.id,'en')).map(hit=>hit.record);
  }
  const canvas=map.getCanvas(), tooltip=$('#map-hover');
  let pointer, frame=0;
  function clearHover() {
    tooltip.hidden=true; canvas.style.cursor='';
  }
  function hover() {
    frame=0;
    const record=pointer && !map.isMoving() && hitsAt(pointer)[0];
    if (!record) {clearHover();return;}
    const props=attributes.get(record.id);
    let label=record.label;
    if(record.layer==='settlements') label+=' · Settlement ('+(props.rank==='-'?'unranked':'Rank '+props.rank)+')';
    else if(record.layer!=='maritime') label+=' · '+(props?.certainty || record.kind);
    tooltip.textContent=label; tooltip.hidden=false; canvas.style.cursor='pointer';
  }
  function scheduleHover() {
    if (pointer && !frame) frame=requestAnimationFrame(hover);
  }
  map.on('mousemove',event=>{pointer=event.point; scheduleHover();});
  canvas.addEventListener('mouseleave',()=>{pointer=null; clearHover();});
  map.on('movestart',clearHover);
  map.on('idle',scheduleHover);
  const autoGroups=groups.filter(group=>group.tier?.atZoom);
  map.on('zoom',()=>{
    if (autoGroups.some(group=>state.tiers[group.id]==='auto' && effective(group)!==currentTier.get(group.id))) refresh();
  });
  map.on('click',event=>{
    overlap=hitsAt(event.point);
    if (overlap.length) select(overlap[0].id,null,'map');
    else showPicker();
  });
  refresh();
  $('#foundation-controls').hidden=false;
}
