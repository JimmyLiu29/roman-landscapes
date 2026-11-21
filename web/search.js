export function normalize(value) {
  return value.normalize('NFD').replace(/[\p{M}\p{Diacritic}]/gu, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, '').replace(/\s+/gu,' ').trim().toLowerCase();
}

export function searchIndex(records) {
  const exact = new Map(), words = new Map(), expansions = new Map();
  const compare = new Intl.Collator('en', {sensitivity:'base'}).compare;
  function add(map,key,value) {
    if (!key) return;
    if (!map.has(key)) map.set(key,new Set());
    map.get(key).add(value);
  }
  for (const r of records) {
    const label = normalize(r.label);
    const aliases = (r.aliases || []).map(normalize);
    words.set(r,{label, aliases, id:normalize(r.id)});
    add(exact,label,r);
    add(exact,normalize(r.id),r);
    for (const alias of aliases) {
      add(exact,alias,r);
      if (r.source==='pleiades') add(expansions,alias,label);
    }
  }
  function rank(record,query,expanded) {
    const {label,aliases,id} = words.get(record);
    if (label===query) return 1;
    if (aliases.includes(query) || id===query || expanded?.has(label)) return 2;
    if (label.startsWith(query)) return 3;
    if (aliases.some(a=>a.startsWith(query))) return 4;
    for (const term of [label,...aliases,id]) {
      let offset=term.indexOf(query);
      while (offset>=0) {
        if (!offset || !/[\p{L}\p{N}]$/u.test(term.slice(0,offset))) return 5;
        offset=term.indexOf(query,offset+1);
      }
    }
    return [label,...aliases,id].some(s=>s.includes(query)) ? 6 : 0;
  }
  function order(a,b) {
    return a.tier-b.tier
      || Number(!!b.record.layer && !!b.record.bbox)-Number(!!a.record.layer && !!a.record.bbox)
      || compare(a.record.label,b.record.label) || a.record.id.localeCompare(b.record.id,'en');
  }
  function* search(value,source='') {
    const q=normalize(value);
    if (!q && !source) return;
    const expanded=expansions.get(q);
    const candidates=new Set(exact.get(q));
    // A gazetteer alias also finds records bearing its title. This expands the query,
    // without assigning an alias or a cross-dataset identity to those other records.
    for (const label of expanded || []) {
      for (const record of exact.get(label) || []) {
        if (words.get(record).label===label) candidates.add(record);
      }
    }
    const direct=[];
    for (const record of candidates) {
      if (source && record.source!==source) continue;
      const terms=words.get(record);
      const tier=rank(record,q,expanded);
      const via=tier===2 && !!expanded?.has(terms.label) && !terms.aliases.includes(q) && terms.id!==q;
      direct.push({record,tier,via});
    }
    yield* direct.sort(order);
    const other=[];
    for (const record of records) {
      if (candidates.has(record) || (source && record.source!==source)) continue;
      const tier=q ? rank(record,q,expanded) : 1;
      if (tier) other.push({record,tier,via:false});
    }
    yield* other.sort(order);
  }
  return {search};
}
