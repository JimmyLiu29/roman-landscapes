const folds = {ł:'l', ø:'o', æ:'ae', œ:'oe', ß:'ss', ı:'i', đ:'d', ς:'σ'};

export function normalize(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value.trim().replace(/ +/g,' ').toLowerCase();
  return value.normalize('NFD').replace(/[\p{M}\p{Diacritic}]/gu, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, '').replace(/\s+/gu,' ').trim().toLowerCase().replace(/[łøæœßıđς]/gu, c => folds[c]);
}

export function searchIndex(records,archives=[]) {
  const archiveIds = new Set(archives.map(a=>a.id));
  const exact = new Map(), words = new Map();
  const compare = new Intl.Collator('en', {sensitivity:'base'}).compare;
  const sorted = [...records].sort((a,b) => compare(a.label,b.label) || a.id.localeCompare(b.id,'en'));
  const sortRank = new Map(sorted.map((record, i) => [record, i]));
  function add(map,key,value) {
    if (!key) return;
    if (!map.has(key)) map.set(key,new Set());
    map.get(key).add(value);
  }
  for (const r of records) {
    const label = normalize(r.label);
    const aliases = (r.aliases || []).map(normalize);
    words.set(r,{label, aliases, id:normalize(r.id), terms:normalize(r.search_terms || '')});
    add(exact,label,r);
    add(exact,normalize(r.id),r);
    for (const alias of aliases) {
      add(exact,alias,r);
    }
  }
  function rank(record,query) {
    const {label,aliases,id,terms} = words.get(record);
    if (label===query) return 1;
    if (aliases.includes(query) || id===query) return 2;
    if (label.startsWith(query)) return 3;
    if (aliases.some(a=>a.startsWith(query))) return 4;
    if (query.length < 2) return 0;
    for (const term of [label,...aliases,id]) {
      let offset=term.indexOf(query);
      while (offset>=0) {
        if (!offset || !/[\p{L}\p{N}]$/u.test(term.slice(0,offset))) return 5;
        offset=term.indexOf(query,offset+1);
      }
    }
    if ([label,...aliases,id].some(s=>s.includes(query))) return 6;
    if (terms.startsWith(query) || terms.includes(' '+query)) return 7;
    return terms.includes(query) ? 8 : 0;
  }
  function order(a,b) {
    return a.tier-b.tier
      || (a.archive ? 0 : Number(b.record.layers.length>0)-Number(a.record.layers.length>0))
      || sortRank.get(a.record)-sortRank.get(b.record);
  }
  function* search(value,source='') {
    const q=normalize(value);
    if (!q && !source) return;
    const archive=archiveIds.has(source);
    if (archive && !q) {
      for (const record of records.filter(r=>r.archive===source).sort((a,b)=>a.source_order-b.source_order))
        yield {record,tier:1};
      return;
    }
    const candidates=exact.get(q) || new Set();
    const direct=[];
    for (const record of candidates) {
      if (source && record.source!==source) continue;
      direct.push({record,tier:rank(record,q),archive});
    }
    yield* direct.sort(order);
    const other=[];
    for (const record of records) {
      if (candidates.has(record) || (source && record.source!==source)) continue;
      const tier=q ? rank(record,q) : 1;
      if (tier) other.push({record,tier,archive});
    }
    yield* other.sort(order);
  }
  return {search};
}
