// Static reference search: the index owns normalized copies and posting lists,
// never guide visibility, progress, DOM nodes or the caller's authored records.
function createGuideSearchIndex(source) {
  const fold = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[‘’]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();
  const records = source.map(record => ({ ...record, name: fold(record.title), search: fold(record.title + ' ' + record.text) }));
  const grams = new Map();
  const questIds = new Map();
  const all = records.map((_, index) => index);
  for (const [index, record] of records.entries()) {
    const quest = /^quest-(\d+)$/.exec(record.id);
    if (quest) questIds.set(quest[1], index);
    const unique = new Set();
    for (let at = 0; at <= record.search.length - 3; at++) unique.add(record.search.slice(at, at + 3));
    for (const gram of unique) {
      if (!grams.has(gram)) grams.set(gram, new Set());
      grams.get(gram).add(index);
    }
  }

  function snippet(record, terms) {
    const text = String(record.text);
    const normalized = fold(text);
    const at = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, at - 32), end = Math.min(text.length, start + 150);
    return (start ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
  }

  function query(value, limit = 30, offset = 0) {
    const query = fold(value);
    if (!query) return { total: 0, items: [] };
    const terms = query.split(' ').filter(Boolean);
    const exactQuest = /^#(\d+)$/.exec(query);
    let candidates;
    if (exactQuest) {
      const index = questIds.get(exactQuest[1]);
      candidates = index === undefined ? [] : [index];
    } else {
      const sets = [];
      for (const term of terms) for (let at = 0; at <= term.length - 3; at++) {
        const posting = grams.get(term.slice(at, at + 3));
        if (!posting) return { total: 0, items: [] };
        sets.push(posting);
      }
      sets.sort((a, b) => a.size - b.size);
      candidates = sets.length ? [...sets[0]].filter(index => sets.every(set => set.has(index))) : all;
      candidates = candidates.filter(index => terms.every(term => records[index].search.includes(term)));
    }
    const rank = record => record.name === query ? 0 : record.name.startsWith(query) ? 1
      : record.name.includes(query) ? 2 : 3 + terms.filter(term => !record.name.includes(term)).length / (terms.length + 1);
    const kindRank = record => ['Guide', 'Weapon checklist'].includes(record.kind) ? 1 : 0;
    candidates.sort((left, right) => rank(records[left]) - rank(records[right])
      || kindRank(records[left]) - kindRank(records[right])
      || records[left].title.localeCompare(records[right].title, 'en', { numeric: true }));
    const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    return { total: candidates.length, items: candidates.slice(start, start + Math.max(1, Math.min(100, limit))).map(index => {
      const record = records[index];
      return { id: record.id, title: record.title, kind: record.kind, href: record.href,
        weaponId: record.weaponId, snippet: snippet(record, terms) };
    }) };
  }
  return { query, size: records.length };
}

if (typeof module === 'object' && module.exports) module.exports = { createGuideSearchIndex };

// The worker owns the index and query CPU work. It has no DOM or save access.
let guideSearchIndex;
self.addEventListener('message', ({ data }) => {
  try {
    if (data.type === 'initialize') {
      guideSearchIndex = createGuideSearchIndex(data.records);
      self.postMessage({ type: 'ready', size: guideSearchIndex.size });
    } else if (data.type === 'query' && guideSearchIndex) {
      self.postMessage({ type: 'result', request: data.request,
        result: guideSearchIndex.query(data.value, data.limit, data.offset) });
    }
  } catch {
    self.postMessage({ type: 'failure', request: data.request });
  }
});

