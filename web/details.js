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
export function renderDetail(record,d,neighbors,select,focusRow,sourcesById) {
  const root=element('section');
  root.className='record-reading';
  root.append(element('h3',record.label.replace(/\s+/g,' ').trim()),element('small',record.kind+' · '+record.id));
  if (Array.isArray(d.notes) && d.notes.length) {
    const notes=element('aside');
    notes.className='record-notes';
    notes.append(...d.notes.map(note=>element('p',note)));
    root.append(notes);
  }
  if (record.kind==='Settlement') {
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
  } else if (record.id==='hanson:bibliography') {
    for (const entry of d.entries) {
      const p=element('p',entry.text); p.id='reference-'+entry.row;
      if (entry.note) p.append(element('small',entry.note));
      if (entry.see_row) p.append(button('Full citation',()=>select(record.id,entry.see_row)));
      if (entry.row===focusRow) { p.className='selected-reference'; p.tabIndex=-1; }
      root.append(p);
    }
  } else if (d.date_bounds) {
    const margin=v=>v==null?'unknown':Math.abs(v)+' years';
    root.append(element('p',roadDates(d)),element('h4','Date uncertainty / margin of error'),
      fields({'Before lower bound':margin(d.date_margins.Low_Date_E),'After upper bound':margin(d.date_margins.Up_Date_E),
        Certainty:d.native.Segment_s,Description:d.native.Descriptio,Citation:d.native.Citation,Bibliography:d.native.Bibliograp}),
      button('Open source bibliography',()=>select('itinere:bibliography')),button('Open field definitions',()=>select('itinere:fields')));
  } else if (record.id==='itinere:bibliography') {
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
  } else if (d.blocks) {
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
  } else if (d.reading) {
    root.append(fields(d.reading));
    if (d.names.length) {
      const section=disclosure('Attested names ('+d.names.length+')');
      for (const name of d.names) {
        const item=fields(name.fields); item.dataset.nameKey=name.key; section.append(item);
      }
      root.append(section);
    }
  } else if (record.kind==='Unresolved network place') {
    root.append(element('p','Unlocated. The source routes reference this node, but the site table supplies no coordinates.'));
  } else if (record.id==='hanson:unmatched') {
    for (const row of d.native) root.append(fields(row));
    root.append(element('p','The incomplete source key does not identify a city.'));
  } else root.append(fields(d.native));
  for (const {other,role,basis,reverse} of neighbors) {
    const label=({'source-endpoint':reverse?'Outgoing maritime route':'Origin',
      'target-endpoint':reverse?'Incoming maritime route':'Destination'})[role] || role;
    const link=button(label+' · '+other.label,()=>select(other.id));
    link.dataset.related=other.id; root.append(link,element('small',basis));
  }
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
