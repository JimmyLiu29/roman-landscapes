const folds = {ł:'l', ø:'o', æ:'ae', œ:'oe', ß:'ss', ı:'i', đ:'d', ς:'σ'};

export function normalize(value) {
  return value.normalize('NFD').replace(/[\p{M}\p{Diacritic}]/gu, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, '').replace(/\s+/gu,' ').trim().toLowerCase().replace(/[łøæœßıđς]/gu, c => folds[c]);
}

export function searchIndex(records) {
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
    words.set(r,{label, aliases, id:normalize(r.id)});
    add(exact,label,r);
    add(exact,normalize(r.id),r);
    for (const alias of aliases) {
      add(exact,alias,r);
    }
  }
  function rank(record,query) {
    const {label,aliases,id} = words.get(record);
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
    return [label,...aliases,id].some(s=>s.includes(query)) ? 6 : 0;
  }
  function order(a,b) {
    return a.tier-b.tier
      || Number(!!b.record.layer && !!b.record.bbox)-Number(!!a.record.layer && !!a.record.bbox)
      || sortRank.get(a.record)-sortRank.get(b.record);
  }
  function* search(value,source='') {
    const q=normalize(value);
    if (!q && !source) return;
    const candidates=exact.get(q) || new Set();
    const direct=[];
    for (const record of candidates) {
      if (source && record.source!==source) continue;
      direct.push({record,tier:rank(record,q)});
    }
    yield* direct.sort(order);
    const other=[];
    for (const record of records) {
      if (candidates.has(record) || (source && record.source!==source)) continue;
      const tier=q ? rank(record,q) : 1;
      if (tier) other.push({record,tier});
    }
    yield* other.sort(order);
  }
  return {search};
}
