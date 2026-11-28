import { normalize } from './search.js';

export function element(tag,text) {
  const node=document.createElement(tag);
  if (text!==undefined) node.textContent=String(text);
  return node;
}
function fields(row) {
  const dl=element('dl');
  for (const [k,v] of Object.entries(row)) {
    if (v!==null && v!==undefined && v!=='') dl.append(element('dt',k),element('dd',typeof v==='object'?JSON.stringify(v):v));
  }
  return dl;
}
function button(text,action) {
  const b=element('button',text);
  b.type='button'; b.onclick=action; return b;
}
function disclosure(title) {
  const block=element('details'); block.append(element('summary',title)); return block;
}
function year(v) {
  if (v==null || v==='NULL' || v==='') return 'unknown';
  const n=Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n===0 ? '0 (source value)' : Math.abs(n)+(n<0?' BCE':' CE');
}
function roadDates(d) {
  const {Lower_Date:lo,Upper_Date:hi}=d.date_bounds;
  if (lo==null && hi==null) return 'Dates unknown';
  if (hi==null) return 'Lower bound: '+year(lo)+' · Upper bound unknown';
  if (lo==null) return 'Lower bound unknown · Upper bound: '+year(hi);
  return year(lo)+' to '+year(hi);
}
function reference(root,c,select) {
  const p=element('p');
  if (c.match==='unresolved') p.textContent=c.token+' · No reliable match in the source bibliography.';
  else {
    const link=button(c.token+(c.grid?' · '+c.grid:''),()=>select('hanson:bibliography',c.row));
    link.dataset.referenceRow=String(c.row);
    p.append(link,element('span',' '+c.text));
    if (c.note) p.append(element('small',c.note));
  }
  root.append(p);
}
function renderDates(root, dates=[]) {
  if (!dates.length) return;
  root.append(element('h4','Dates'));
  for (const d of dates) root.append(fields({[d.label]:d.display, Calendar:d.calendar, Basis:d.basis,
    Sentinel:d.sentinel, Qualifiers:d.qualifiers?.length ? d.qualifiers : null}));
}

function tableRows(root, tables={}) {
  for (const [title,rows] of Object.entries(tables)) {
    const block=disclosure(title+' ('+rows.length+')');
    for (const row of rows) block.append(fields(row));
    root.append(block);
  }
}

function statement(root, item) {
  const stmt=item.Statement;
  const block=disclosure(item.Entity+' · '+item.Property+' · revision '+item.Revision);
  block.append(fields({Entity:item.Entity,Revision:item.Revision,Property:item.Property,Statement:stmt.id,
    Rank:stmt.rank,Value:stmt.mainsnak,Qualifiers:stmt.qualifiers}));
  if (stmt.references?.length) {
    for (const reference of stmt.references) block.append(fields(reference));
  } else block.append(element('p','No source reference recorded'));
  root.append(block);
}

function historical(root,d,select) {
  root.append(fields(d.summary));
  if (d.render_kind==='history_person')
    root.append(element('p','414 people have activity or event locations and 944 have biographical locations. Both groups include the same 150 people.'));
  const url=URL.parse(d.source_url);
  if (url && ['http:','https:'].includes(url.protocol)) {
    const link=element('a','Wikidata source'); link.href=url.href; link.target='_blank'; link.rel='noopener noreferrer'; root.append(link);
  }
  for (const link of d.history_links) {
    const section=disclosure(link.role+' · '+link.node);
    section.append(button('Open associated town',()=>select(link.node)),fields({Tier:link.tier,Basis:link.basis,Via:link.via}));
    for (const item of link.statement_evidence || []) statement(section,item);
    root.append(section);
  }
  if (d.dated_supporting_events?.length) {
    root.append(element('h4','Supporting dating events'));
    for (const item of d.dated_supporting_events) {
      const section=disclosure(item.event_label+' · '+item.event_qid);
      section.append(fields({Event:item.event_label,Entity:item.event_qid,Revision:item.event_revision,Role:item.role}));
      if (item.event_record_id) section.append(button('Open event',()=>select(item.event_record_id)));
      renderDates(section,item.dates);
      statement(section,item.association_statement);
      for (const [property,statements] of Object.entries(item.date_statements)) {
        for (const stmt of statements) statement(section,{Entity:item.event_qid,Revision:item.event_revision,Property:property,Statement:stmt});
      }
      root.append(section);
    }
  }
}

const relationLabels={
  maritime_endpoint:['Route endpoints','Connected routes'], economic_place:['Associated places','Economic records'],
  findspot_assemblage:['Source assemblage','Amphora observations'],amphora_type:['Amphora types','Amphora observations'],
  type_concordance:['Type concordance','Corresponding types'],document_place:['Document places','Document references'],
  event_town:['Associated towns','Historical events'],person_event:['Related events','Associated people'],
  person_activity_town:['Activity & event towns','People: activity & events'],
  person_biography_town:['Biographical towns','People: birth, death & burial'],archive_member:['Collection archive','Archive members']
};
function renderRelations(root,neighbors,select) {
  const grouped=Map.groupBy(neighbors,item=>relationLabels[item.group][Number(item.reverse)]);
  for (const [title,items] of grouped) {
    const group=disclosure(title+' ('+items.length+' links)');
    let offset=0;
    const more=button('Show 25 more',append);
    function append() {
      more.remove();
      for (const {other,basis,role} of items.slice(offset,offset+25)) {
        const link=button(role+' · '+other.label,()=>select(other.id));
        link.dataset.related=other.id; group.append(link,element('small',basis));
      }
      offset+=25;
      if (offset<items.length) group.append(more);
    }
    append(); root.append(group);
  }
}
export function renderDetail(record,d,neighbors,select,focusRow,sourcesById,browse,archives) {
  const root=element('section');
  root.className='record-reading';
  root.append(element('h3',record.label.replace(/\s+/g,' ').trim()),element('small',record.kind+' · '+record.id));
  if (d.warnings?.length) {
    const warnings=element('aside'); warnings.className='record-warnings';
    for (const w of d.warnings) {
      const text=element('p',w.message); text.dataset.warningCode=w.code; warnings.append(text);
    }
    root.append(warnings);
  }
  if (Array.isArray(d.notes) && d.notes.length) {
    const notes=element('aside');
    notes.className='record-notes';
    notes.append(...d.notes.map(note=>element('p',note)));
    root.append(notes);
  }
  root.append(fields({'Spatial status':d.geometry_status.replaceAll('_',' '),'Location note':d.geometry_note}));
  for (const [layer,occ] of Object.entries(d.occurrences || {})) root.append(fields({Layer:layer,'Position basis':occ.position_basis.replaceAll('-',' ')}));
  renderDates(root,d.dates);
  switch (d.render_kind) {
  case 'hanson_settlement': {
    const native=d.native;
    root.append(fields({Province:native.Province, Country:native.Country,'Modern name':native['Modern Toponym'],
      'Start date':year(native['Start Date']),'End date':year(native['End Date'])}));
    for (const [title,rows] of Object.entries(d.tables||{})) {
      const block=disclosure(title+' ('+rows.length+')');
      for (const row of rows) block.append(fields(Object.fromEntries(Object.entries(row).filter(([k])=>!['source_row','Primary Key'].includes(k)))));
      root.append(block);
    }
    root.append(element('h4','Bibliography'));
    if (d.atlas_reference) reference(root,d.atlas_reference,select);
    for (const c of d.citations) reference(root,c,select);
    root.append(button('Open source bibliography',()=>select('hanson:bibliography')));
    break;
  }
  case 'hanson_bibliography': {
    for (const entry of d.entries) {
      const p=element('p',entry.text); p.id='reference-'+entry.row;
      if (entry.note) p.append(element('small',entry.note));
      if (entry.see_row) p.append(button('Full citation',()=>select(record.id,entry.see_row)));
      if (entry.row===focusRow) { p.className='selected-reference'; p.tabIndex=-1; }
      root.append(p);
    }
    break;
  }
  case 'itinere_road': {
    const margin=v=>v==null?'unknown':Math.abs(v)+' years';
    root.append(element('p',roadDates(d)),element('h4','Date uncertainty / margin of error'),
      fields({'Before lower bound':margin(d.date_margins.Low_Date_E),'After upper bound':margin(d.date_margins.Up_Date_E),
        Certainty:d.native.Segment_s,Description:d.native.Descriptio,Citation:d.native.Citation,Bibliography:d.native.Bibliograp}),
      button('Open source bibliography',()=>select('itinere:bibliography')),button('Open field definitions',()=>select('itinere:fields')));
    break;
  }
  case 'itinere_bibliography': {
    const filter=element('input'); filter.type='search'; filter.placeholder='Search bibliography'; filter.setAttribute('aria-label','Search bibliography');
    const list=element('div');
    function show() {
      const q=normalize(filter.value || '');
      list.replaceChildren();
      for (const entry of d.entries) {
        if (!normalize(Object.values(entry).join(' ')).includes(q)) continue;
        const block=disclosure(entry.title||entry.key); block.dataset.citation=entry.key;
        block.append(fields(entry)); list.append(block);
      }
    }
    filter.oninput=show; show(); root.append(filter,list);
    break;
  }
  case 'itinere_fields': {
    for (const block of d.blocks) {
      if (block.paragraph) {
        const p=element('p',block.paragraph); p.className='field-paragraph'; root.append(p);
      }
      else {
        const table=element('table');
        block.rows.forEach((row,i)=>{
          const tr=element('tr');
          for (const cell of row) {
            const td=element(i?'td':'th',cell.text ?? cell);
            td.colSpan=cell.span ?? 1; tr.append(td);
          }
          table.append(tr);
        });
        root.append(table);
      }
    }
    break;
  }
  case 'pleiades_place': {
    root.append(fields(d.reading));
    if (d.names.length) {
      const section=disclosure('Attested names ('+d.names.length+')');
      for (const name of d.names) {
        const item=fields(name.fields); item.dataset.nameKey=name.key; section.append(item);
      }
      root.append(section);
    }
    break;
  }
  case 'orbis_place': {
    root.append(fields(d.native));
    if (d.geometry_status==='missing_coordinate') root.append(element('p','Unlocated. The source routes reference this node, but the site table supplies no coordinates.'));
    break;
  }
  case 'hanson_unmatched': {
    for (const row of d.native) root.append(fields(row));
    root.append(element('p','The incomplete source key does not identify a city.'));
    break;
  }
  case 'orbis_route':
    root.append(fields(d.native)); break;
  case 'economy_mine': case 'economy_shipwreck': case 'economy_raad_assemblage':
  case 'economy_raad_observation': case 'economy_karanis_transaction': case 'economy_press_group':
  case 'economy_quarry': case 'economy_water_reference':
    root.append(fields(d.summary)); tableRows(root,d.tables);
    if (d.normalized_fields) {const block=disclosure('Normalized source fields'); block.append(fields(d.normalized_fields)); root.append(block);}
    break;
  case 'economy_karanis_archive':
    root.append(fields(d.crosswalk),button('Browse '+archives.find(a=>a.id===d.archive_source).record_count.toLocaleString('en-US')+' transactions',()=>browse(d.archive_source))); break;
  case 'source_note': case 'economy_document_place': case 'economy_raad_type':
    for (const row of Array.isArray(d.native)?d.native:[d.native]) root.append(fields(row));
    if (d.summary) root.append(fields(d.summary));
    tableRows(root,d.tables); break;
  case 'history_event': case 'history_person':
    historical(root,d,select); break;
  default: throw new Error('Unknown record presentation');
  }
  renderRelations(root,neighbors,select);
  const original=disclosure('Original source fields');
  original.className='original-source';
  original.ontoggle=()=>{
    if (!original.open || original.children.length>1) return;
    const payload=d.native.BibTeX ?? JSON.stringify({native:d.native,tables:d.tables,native_crs:d.native_crs,native_geometry:d.native_geometry},null,2);
    original.append(element('pre',payload));
  };
  root.append(original);
  const source=sourcesById?.get(record.source);
  if (source) {
    const cite=element('footer');
    cite.append(element('strong','Cite this source'),element('p',source.citation),element('small',source.terms));
    root.append(cite);
  }
  return root;
}
