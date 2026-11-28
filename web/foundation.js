import { searchIndex } from './search.js';
import { element, renderDetail } from './details.js';

import { economyColors, registry } from './layers.js';

const $=selector=>document.querySelector(selector);
const empty={type:'FeatureCollection',features:[]};

function geometryBounds(coordinates, bounds) {
  if (!Array.isArray(coordinates)) return bounds;
  const [x,y] = coordinates;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    if (!bounds) return [x,y,x,y];
    bounds[0] = Math.min(bounds[0],x); bounds[1] = Math.min(bounds[1],y);
    bounds[2] = Math.max(bounds[2],x); bounds[3] = Math.max(bounds[3],y);
  } else {
    for (const child of coordinates) bounds = geometryBounds(child, bounds);
  }
  return bounds;
}

export function relationIndex(edges,byID) {
  const neighbors=new Map();
  for (const edge of edges) {
    if (!byID.has(edge.from)||!byID.has(edge.to)) continue;
    for (const [id,other] of [[edge.from,edge.to],[edge.to,edge.from]]) {
      if (id===edge.to && edge.group==='archive_member') continue;
      if (!neighbors.has(id)) neighbors.set(id,[]);
      neighbors.get(id).push({other:byID.get(other),group:edge.group,source:edge.source,role:edge.role,basis:edge.basis,reverse:id===edge.to});
    }
  }
  return neighbors;
}

export async function mountFoundation(map,release,load,preferences={},persist=()=>{},sourcesById=new Map(),reloadAtlas) {
  const {datasets,groups,archives}=registry(release);
  if (!datasets.length) return;
  const sources=new Map(datasets.map(d=>[d.id,d.label]));
  const files=groups.flatMap(g=>g.sources);
  const [catalog,edges,...collections]=await Promise.all(['catalog.json.gz','relations.json.gz',
    ...files.map(file=>file.id+'.geojson.gz')].map(load));
  const records=catalog.records.filter(r=>sources.has(r.source));
  const byID=new Map(records.map(r=>[r.id,r])), index=searchIndex(records,archives);
  const labelOf = id => byID.get(id)?.label;
  const associations = sourcesById.get('wikidata-history')?.accounting?.person_associations ||
    records.reduce((counts, record) => {
      const activity = record.layers.includes('people'), biography = record.layers.includes('people-biography');
      counts.activity += Number(activity); counts.biography += Number(biography); counts.both += Number(activity && biography);
      return counts;
    }, {activity:0, biography:0, both:0});
  const neighbors=relationIndex(edges,byID);
  const contents=new Map(files.map((file,i)=>[file.id,collections[i]]));
  const styles=files.flatMap(file=>file.styles.map(style=>({...style,source:file.id,drawOrder:file.drawOrder})));
  const sourceGroup=new Map(groups.flatMap(group=>group.sources.map(source=>[source.id,group])));
  const attributes=new Map(collections.flatMap(fc=>fc.features.map(f=>[f.properties.occurrence_id,f.properties])));
  const state={...preferences,state_schema:2,tiers:{...preferences?.tiers},
    categories:{economy:preferences?.state_schema===2 ? preferences.categories?.economy || '' : ''}};
  for (const g of groups) {
    state[g.id]=(!g.defaultVisible && preferences?.state_schema!==2) ? false : preferences?.[g.id] ?? g.defaultVisible;
  }
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
    if (!visible(layer) || (state.categories[group?.id] && props?.category!==state.categories[group.id])) return false;
    const values=currentTier.get(layer)?.values;
    return !values || values.includes(props?.[group.tier.field]);
  }
  let selected, category='', overlap=[];
  const picker=$('#overlap-picker'), choices=$('#overlap-records');
  let highlighted=null;
  function highlight() {
    const layers=selected?.record.layers || [];
    const visibleLayers=layers.filter(layer=>allowed(layer,attributes.get(selected.record.id+'#'+layer)));
    const shownLayers=visibleLayers.length ? visibleLayers : layers;
    const noticeHidden=!layers.length || Boolean(visibleLayers.length);
    const banner=$('#selection-notice');
    if (banner) banner.hidden=noticeHidden;
    const key=selected ? [selected.record.id,shownLayers.join(','),noticeHidden].join('|') : '';
    if (key===highlighted) return;
    highlighted=key;
    const geometries=shownLayers.map(layer=>selected.detail.occurrences[layer].geometry);
    if (!geometries.length && selected?.detail.geometry_status==='selected_only') geometries.push(selected.detail.geometry);
    map.getSource('selected-record').setData({type:'FeatureCollection',features:geometries.map(geometry=>({
      type:'Feature',properties:{id:selected.record.id},geometry
    }))});
  }
  function revealPanel() {
    if (matchMedia('(max-width:740px)').matches) $('.map-panel').scrollIntoView({block:'start'});
    else $('#record-panel').scrollIntoView({block:'nearest'});
  }
  function showPicker(reveal=false) {
    const focus=choices.contains(document.activeElement)?document.activeElement.dataset.record:null;
    const hits=overlap.filter(hit=>allowed(hit.layer,hit.props) || hit.record.layers.some(l=>allowed(l,attributes.get(hit.record.id+'#'+l))));
    picker.hidden=hits.length<2;
    choices.replaceChildren();
    if (picker.hidden) return;
    $('#overlap-count').textContent=hits.length+' overlapping records at this location';
    for (const {record} of hits) {
      const button=element('button',record.label);
      button.dataset.record=record.id;
      button.append(element('small',sources.get(record.source)+' · '+(record.category || record.kind)));
      button.setAttribute('aria-pressed',String($('#record-panel').dataset.record===record.id));
      button.onclick=()=>select(record.id,null,'picker');
      choices.append(button);
      if (record.id===focus) button.focus({preventScroll:true});
    }
    if (reveal) revealPanel();
  }
  for (const file of files) map.addSource(file.id,{type:'geojson',data:contents.get(file.id),
    promoteId:'occurrence_id',attribution:sourceGroup.get(file.id).attribution});
  // Draw point symbols above linework; picking has a separate explicit priority.
  for (const style of styles.toSorted((a,b)=>a.drawOrder-b.drawOrder)) {
    const {priority,drawOrder,...spec}=style;
    map.addLayer({...spec,layout:{...spec.layout,visibility:visible(style.source)?'visible':'none'}});
  }
  map.addSource('selected-record',{type:'geojson',data:empty});
  map.addLayer({id:'selected-point',source:'selected-record',type:'circle',
    filter:['in',['geometry-type'],['literal',['Point','MultiPoint']]],
    paint:{'circle-radius':7,'circle-color':'#f0e442','circle-stroke-color':'#111111','circle-stroke-width':2}});
  const selectedLine={source:'selected-record',type:'line',
    filter:['in',['geometry-type'],['literal',['LineString','MultiLineString']]]};
  map.addLayer({...selectedLine,id:'selected-line-casing',paint:{'line-width':6,'line-color':'#111111'}});
  map.addLayer({...selectedLine,id:'selected-line',paint:{'line-width':3,'line-color':'#f0e442'}});
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
        key.hidden=!visible(source) || Boolean(state.categories[group.id] && !values?.includes(state.categories[group.id])) || Boolean(values && choice?.values && !values.some(v=>choice.values.includes(v)));
      }
    }
    for (const style of styles) {
      const group=sourceGroup.get(style.source);
      const choice=currentTier.get(style.source);
      const categoryValue=state.categories[group.id] || '';
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
    if (group.id==='economy') {
      const select=element('select'); select.id='economy-category';
      select.setAttribute('aria-label','Economic evidence category');
      select.add(new Option('All economic evidence',''));
      for (const name of Object.keys(economyColors)) select.add(new Option(name,name));
      select.value=state.categories.economy; row.append(select); ui.select=select;
      select.onchange=()=>{state.categories.economy=select.value; save();};
    }
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
    showPicker(); revealPanel();
    const body=$('#record-content'); body.replaceChildren(element('p','Loading record…'));
    selected=null; highlight();
    try {
      const name=record.detail;
      const promise=cache.get(name) || load(name);
      cache.delete(name); cache.set(name,promise);
      const historical=[...cache.keys()].filter(key=>key.startsWith('details-wikidata-history-'));
      if (historical.length>2) cache.delete(historical[0]);
      if (cache.size>6) cache.delete(cache.keys().next().value);
      let shard;
      try { shard=await promise; }
      catch (error) { if (cache.get(name)===promise) cache.delete(name); throw error; }
      if (turn!==generation) return;
      const detail=shard[id];
      const banner=element('p',"This record's layer or detail filter is currently hidden; the selected geometry is highlighted for inspection.");
      banner.id='selection-notice'; banner.hidden=true;
      body.replaceChildren(banner,renderDetail(record,detail,neighbors.get(id)||[],(other,row)=>select(other,row,'relation'),focusRow,sourcesById,browse,archives,labelOf,associations));
      selected={record,detail}; highlight();
      if (locate) {
        const boxes=record.layers.filter(l=>allowed(l,attributes.get(id+'#'+l))).map(l=>record.layer_bboxes?.[l]).filter(Boolean);
        let bounds=record.bbox;
        if (boxes.length) bounds=[0,1,2,3].map((i)=>(i<2?Math.min:Math.max)(...boxes.map(box=>box[i])));
        if (!bounds) bounds = geometryBounds(detail.geometry?.coordinates);
        if (bounds) map.fitBounds([[bounds[0],bounds[1]],[bounds[2],bounds[3]]],{maxZoom:6,padding:40,duration:0});
      }
      panel.dataset.loaded=id;
      if (focusRow) body.querySelector('.selected-reference')?.focus();
    } catch (error) {
      if (turn!==generation) return;
      body.replaceChildren(element('p',error.message));
      if (error.status===404) {
        const reload=element('button','Reload'); reload.onclick=reloadAtlas; body.append(reload);
      }
    }
  }
  $('#close-record').onclick=()=>{++generation; selected=null;overlap=[];showPicker();highlight();$('#record-panel').hidden=true;$('#search').focus();};
  const filter=$('#search-source');
  for (const [id,title] of sources) filter.add(new Option(title,id));
  const categoryFilter=$('#search-category');
  const kindOf=r=>r.category || r.kind;
  const categories=new Set(records.map(kindOf).filter(Boolean));
  categoryFilter.hidden=!categories.size;
  for (const name of [...categories].sort()) categoryFilter.add(new Option(name,name));
  let hits=[], shown=0;
  function more() {
    const focusMore=document.activeElement===$('#more-results');
    const first=shown;
    for (const {record} of hits.slice(shown,shown+25)) {
      const button=element('button',record.label.replace(/\s+/g,' ').trim());
      const certainty=attributes.get(record.id+'#roads')?.certainty;
      const suffix=record.source==='itinere' && certainty?' · '+certainty+' · #'+record.id.split(':').at(-1):'';
      button.append(element('small',sources.get(record.source)+suffix));
      button.dataset.record=record.id; button.onclick=()=>select(record.id);
      $('#search-results').append(button);
    }
    shown+=25; $('#more-results').hidden=shown>=hits.length;
    if (focusMore && $('#more-results').hidden) $('#search-results').children[first]?.focus();
  }
  function browse(source) {
    filter.value=source; $('#search').value=''; categoryFilter.value=category='';
    search(); $('#search').focus();
  }
  for (const archive of archives) {
    const open=element('button',archive.label+' ('+number(archive.record_count)+')');
    open.dataset.archive=archive.id; open.onclick=()=>browse(archive.id); $('#archives').append(open);
    if (archive.anchor_id) {
      const anchor=element('button','Open Karanis map anchor'); anchor.className='archive-anchor'; anchor.onclick=()=>select(archive.anchor_id);
      $('#archives').append(anchor);
    }
  }
  function search() {
    const notices=archives.find(a=>a.id===filter.value)?.collection_notices || [];
    $('#collection-notices').replaceChildren(...notices.map(n=>element('p',n.message)));
    const candidates=category && !filter.value && !$('#search').value.trim()
      ? records.map(record=>({record})) : index.search($('#search').value,filter.value);
    hits=[...candidates].filter(hit=>!category || kindOf(hit.record)===category); shown=0;
    $('#search-results').replaceChildren(); $('#search-status').textContent=hits.length===1 ? '1 result' : hits.length+' results'; more();
  }
  let timer;
  $('#search').oninput=()=>{clearTimeout(timer);timer=setTimeout(search,120);};
  filter.onchange=search; $('#more-results').onclick=more;
  categoryFilter.onchange=()=>{category=categoryFilter.value; search();};
  const priority=new Map(files.map(f=>[f.id,f.pickPriority]));
  const compare=(a,b)=>a.priority-b.priority || a.rank-b.rank || a.distance-b.distance || a.record.id.localeCompare(b.record.id,'en');
  function hitsAt(point) {
    const layers=styles.filter(style=>visible(style.source)).map(style=>style.id);
    if (!layers.length) return [];
    const {x,y}=point, candidates=new Map();
    for (const f of map.queryRenderedFeatures([[x-5,y-5],[x+5,y+5]],{layers})) {
      const props=f.properties, record=byID.get(props.record_id);
      if (!record || !allowed(f.source,props)) continue;
      const coords=f.geometry.type==='Point' ? [f.geometry.coordinates] :
        f.geometry.type==='MultiPoint' ? f.geometry.coordinates : [];
      const distances=coords.map(coord=>{const p=map.project(coord); return Math.hypot(p.x-x,p.y-y);});
      const hit={record,layer:f.source,props,priority:priority.get(f.source),
        rank:f.source==='settlements' && Number(props.rank)>0 ? Number(props.rank) : Infinity,
        distance:distances.length ? Math.min(...distances) : 0};
      if (!candidates.has(record.id) || compare(hit,candidates.get(record.id))<0) candidates.set(record.id,hit);
    }
    return [...candidates.values()].sort(compare);
  }
  const canvas=map.getCanvas(), tooltip=$('#map-hover');
  let pointer, frame=0;
  function clearHover() {
    tooltip.hidden=true; canvas.style.cursor='';
  }
  function hover() {
    frame=0;
    const hit=pointer && !map.isMoving() && hitsAt(pointer)[0];
    if (!hit) {clearHover();return;}
    const {record,layer,props}=hit;
    let label=record.label;
    if(layer==='settlements') label+=' · Settlement ('+(props.rank==='-'?'unranked':'Rank '+props.rank)+')';
    else if(props?.ferry) label+=' · Temporary ferry connector'+(props.certainty?' · '+props.certainty:'');
    else label+=' · '+(props.certainty || (layer==='ports'?'Maritime port':sourceGroup.get(layer).title));
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
    if (overlap.length>1) {
      ++generation; selected=null; highlight();
      const panel=$('#record-panel'); panel.hidden=false; delete panel.dataset.record; delete panel.dataset.loaded;
      $('#record-content').replaceChildren(element('p','Choose a record to inspect.'));
      showPicker(true);
    } else if (overlap.length) select(overlap[0].record.id,null,'map');
    else showPicker();
  });
  refresh();
  $('#foundation-controls').hidden=false;
}
