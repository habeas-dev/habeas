// Adapter runtime: given an adapter (declarative data) + captured auth, enumerate all
// documents and fetch a document's PDF. Runs in an extension page (host_permissions grant the
// cross-origin fetch without CORS).
//
// The pager is declarative — an adapter picks a `paging` strategy and the field mapping; the
// runtime stays source-agnostic. Carrefour uses `offsets` paging; other sources use
// `page` / `cursor` / `none`.
import { buildRecord } from '../sinks/format.js';
import { chrome } from '../lib/ext.js';

// Some services gate the PDF behind a Referer that must be the document's detail page. A page/
// extension fetch cannot set Referer (forbidden header) — declarativeNetRequest is the MV3 way.
let __ruleSeq = 1;
async function withReferer(targetUrl, referer, fn) {
  if (!referer || !(chrome && chrome.declarativeNetRequest)) return fn();
  const id = 100000 + ((__ruleSeq++) % 90000);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
        condition: { urlFilter: targetUrl, resourceTypes: ['xmlhttprequest'] },
      }],
    });
  } catch (e) { return fn(); }
  try { return await fn(); }
  finally { try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch (e) {} }
}

export async function listInventory(adapter, auth, net) {
  const list = adapter.api.list;
  const paging = list.paging || (list.offsetsPath ? 'offsets' : list.nextPath ? 'cursor' : 'none');
  const baseParams = { ...(list.params || {}) };
  const range = rangeParams(list);
  const count = list.params && list.params.count;
  const maxPages = list.maxPages || 100;
  const seen = new Set(), all = [];
  const call = (params) => fetchList(adapter, auth, params, net);

  if (paging === 'offsets') {
    let offs = { ...(list.initialOffsets || {}) };
    for (let g = 0; g < maxPages; g++) {
      const data = await call({ ...range, ...baseParams, ...offs });
      if (!collect(adapter, data, seen, all)) break;
      offs = Object.assign(offs, get(data, list.offsetsPath) || {});
    }
  } else if (paging === 'page') {
    const pageParam = list.pageParam || 'page';
    let page = list.pageStart ?? 1;
    for (let g = 0; g < maxPages; g++) {
      const data = await call({ ...range, ...baseParams, [pageParam]: page });
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
      const data = await call(params);
      const added = collect(adapter, data, seen, all);
      cursor = get(data, list.nextPath);
      if (!added || !cursor) break;
    }
  } else { // 'none' — single request
    collect(adapter, await call({ ...range, ...baseParams }), seen, all);
  }
  all.sort((x, y) => (x.date < y.date ? 1 : -1));
  return all;
}

const absHost = (h) => (/^https?:\/\//.test(h) ? h : 'https://' + h);

// Resolve the headers to replay for a given endpoint path from the captured auth STORE
// ({ byPath, merged }). Different endpoints can use different auth (e.g. cookie-authed list +
// bearer-authed PDF) — each replays what was captured for ITS path, falling back to the union.
// `allowMerged=false` (cookie endpoints) avoids leaking a bearer captured elsewhere.
function headersFor(auth, path, allowMerged = true) {
  if (!auth) return {};
  if (auth.byPath || auth.merged) {
    const exact = path && auth.byPath && auth.byPath[path];
    if (exact) return exact;
    return allowMerged ? (auth.merged || {}) : {};
  }
  return auth; // already a plain headers object (tests / direct callers)
}

// Which per-document artifact this source produces: a PDF (GET, or POST-generated) or a JSON detail
// (GET). JSON detail is preferred when present — it's the practical artifact for many services.
export function documentExt(adapter) {
  const pdf = adapter.api.pdf, detail = adapter.api.detail;
  if (pdf && (!pdf.method || pdf.method === 'GET')) return 'pdf';
  if (detail) return 'json';
  if (pdf) return 'pdf';
  return null;
}

// Fetch a document's file (PDF or JSON detail) as a Blob. Prefers GET-PDF, then JSON detail, then
// POST-PDF (see documentExt ordering).
export async function fetchDocument(adapter, auth, externalId, net) {
  const ext = documentExt(adapter);
  if (ext === 'pdf') return { blob: await fetchPdf(adapter, auth, externalId, net), ext };
  if (ext === 'json') return { blob: await fetchDetail(adapter, auth, externalId, net), ext };
  throw new Error('no document for this source');
}

export async function fetchPdf(adapter, auth, externalId, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const pdf = adapter.api.pdf;
  if (!pdf) throw new Error('no PDF for this source');
  const host = pdf.host ? absHost(pdf.host) : adapter.api.host;
  const path = pdf.path.replace('{externalId}', encodeURIComponent(externalId));
  const url = host + path;
  const init = { method: pdf.method || 'GET', headers: { ...headersFor(auth, path), accept: 'application/pdf' }, credentials: 'include', wantBlob: true };
  if (init.method !== 'GET' && pdf.body != null) {
    init.body = String(pdf.body).split('{externalId}').join(externalId);
    init.headers['content-type'] = pdf.contentType || 'application/json';
  }
  const referer = pdf.referer ? String(pdf.referer).split('{externalId}').join(externalId) : null;
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) {
    const hint = res.status === 406 ? ' (sin PDF disponible — típico en tickets antiguos)' : '';
    throw new Error('pdf ' + res.status + hint + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  }
  return await res.blob();
}

// Per-document JSON detail (e.g. an order's full data). Saved as <id>.json.
export async function fetchDetail(adapter, auth, externalId, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const d = adapter.api.detail;
  if (!d) throw new Error('no detail for this source');
  const host = d.host ? absHost(d.host) : adapter.api.host;
  const path = d.path.replace('{externalId}', encodeURIComponent(externalId));
  const url = host + path;
  const res = await NET(url, { method: d.method || 'GET', headers: { ...headersFor(auth, path), accept: 'application/json' }, credentials: 'include' });
  if (!res.ok) throw new Error('detail ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  return new Blob([await res.text()], { type: 'application/json' });
}

async function fetchList(adapter, auth, params, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const url = adapter.api.host + adapter.api.list.path + '?' + new URLSearchParams(params);
  // Run in the site's tab (page context) so cookies + cf_clearance + fingerprint carry through and
  // Cloudflare/Akamai don't challenge it; credentials:'include' carries cookies.
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const res = await NET(url, { headers: headersFor(auth, adapter.api.list.path, !cookie), credentials: 'include' });
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
