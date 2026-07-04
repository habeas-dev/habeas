// Adapter runtime: given an adapter (declarative data) + captured auth, enumerate all
// documents and fetch a document's PDF. Runs in an extension page (host_permissions grant the
// cross-origin fetch without CORS).
//
// The pager is declarative — an adapter picks a `paging` strategy and the field mapping; the
// runtime stays source-agnostic. Carrefour uses `offsets` paging; other sources use
// `page` / `cursor` / `none`.
import { buildRecord } from '../sinks/format.js';

export async function listInventory(adapter, auth) {
  const list = adapter.api.list;
  const paging = list.paging || (list.offsetsPath ? 'offsets' : list.nextPath ? 'cursor' : 'none');
  const baseParams = { ...(list.params || {}) };
  const range = rangeParams(list);
  const count = list.params && list.params.count;
  const maxPages = list.maxPages || 100;
  const seen = new Set(), all = [];

  if (paging === 'offsets') {
    let offs = { ...(list.initialOffsets || {}) };
    for (let g = 0; g < maxPages; g++) {
      const data = await fetchList(adapter, auth, { ...range, ...baseParams, ...offs });
      if (!collect(adapter, data, seen, all)) break;
      offs = Object.assign(offs, get(data, list.offsetsPath) || {});
    }
  } else if (paging === 'page') {
    const pageParam = list.pageParam || 'page';
    let page = list.pageStart ?? 1;
    for (let g = 0; g < maxPages; g++) {
      const data = await fetchList(adapter, auth, { ...range, ...baseParams, [pageParam]: page });
      const items = get(data, list.itemsPath) || [];
      collect(adapter, data, seen, all);
      if (!items.length || (count && items.length < count)) break;
      page++;
    }
  } else if (paging === 'cursor') {
    const cursorParam = list.cursorParam || 'cursor';
    let cursor = null;
    for (let g = 0; g < maxPages; g++) {
      const params = { ...range, ...baseParams };
      if (cursor) params[cursorParam] = cursor;
      const data = await fetchList(adapter, auth, params);
      const added = collect(adapter, data, seen, all);
      cursor = get(data, list.nextPath);
      if (!added || !cursor) break;
    }
  } else { // 'none' — single request
    collect(adapter, await fetchList(adapter, auth, { ...range, ...baseParams }), seen, all);
  }
  all.sort((x, y) => (x.date < y.date ? 1 : -1));
  return all;
}

export async function fetchPdf(adapter, auth, externalId) {
  if (!adapter.api.pdf) throw new Error('no PDF for this source');
  const url = adapter.api.host + adapter.api.pdf.path.replace('{externalId}', encodeURIComponent(externalId));
  const res = await fetch(url, { headers: { ...auth, accept: 'application/pdf' } });
  if (!res.ok) {
    const hint = res.status === 406 ? ' (sin PDF disponible — típico en tickets antiguos)' : '';
    throw new Error('pdf ' + res.status + hint + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  }
  return await res.blob();
}

async function fetchList(adapter, auth, params) {
  const url = adapter.api.host + adapter.api.list.path + '?' + new URLSearchParams(params);
  const res = await fetch(url, { headers: auth });
  if (!res.ok) throw new Error('list ' + res.status + ' — ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
  return await res.json();
}

// Map fresh items onto the shared docs array; returns how many were newly added.
function collect(adapter, data, seen, all) {
  const items = get(data, adapter.api.list.itemsPath) || [];
  const f = adapter.fields;
  let added = 0;
  for (const p of items) {
    const id = get(p, f.externalId);
    if (seen.has(id)) continue;
    seen.add(id); all.push(mapDoc(adapter, p)); added++;
  }
  return added;
}

function mapDoc(adapter, p) {
  const f = adapter.fields, doc = { _raw: p };
  for (const k in f) doc[k] = get(p, f[k]);
  doc.category = categorize(adapter, p);
  // A generic display label across schemas (store / issuer / counterparty / instrument / …).
  doc.label = doc.storeName || doc.issuer || doc.counterparty || doc.instrument || doc.description || doc.party || '';
  doc.record = buildRecord(doc, adapter);
  return doc;
}
function categorize(adapter, p) {
  const c = adapter.categorize;
  if (!c) return (adapter.categories && adapter.categories[0]) || 'other';
  return (c.map && c.map[get(p, c.field)]) || c.default || 'other';
}
function rangeParams(list) {
  if (!list.range) return {};
  const now = new Date();
  const from = new Date(Date.now() - windowMs(list.window));
  const fmt = (dt) => (list.range.format === 'date' ? dt.toISOString().slice(0, 10) : dt.toISOString());
  const out = {};
  if (list.range.from) out[list.range.from] = fmt(from);
  if (list.range.to) out[list.range.to] = fmt(now);
  return out;
}
// Safe dotted-path getter: get(obj, 'a.b.c'); falls back to a plain key when there's no dot.
function get(obj, path) {
  if (obj == null || path == null) return undefined;
  if (String(path).indexOf('.') < 0) return obj[path];
  return String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function windowMs(w) {
  const m = /^(\d+)y$/.exec(w || '3y');
  return (m ? +m[1] : 3) * 365 * 24 * 3600 * 1000;
}
