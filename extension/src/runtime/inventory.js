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
  // Resolve the strategy from an explicit `paging`, else from whichever paging field is present
  // (robust to a blank `paging` — e.g. an editor/UI that didn't offer the right option).
  const paging = list.paging
    || (list.offsetsPath ? 'offsets' : list.offsetParam ? 'offset' : list.pageParam ? 'page' : list.nextPath ? 'cursor' : 'none');
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
      const added = collect(adapter, data, seen, all);
      if (!items.length || !added) break; // empty page or nothing new → done (don't stop on a short page)
      page++;
    }
  } else if (paging === 'offset') {
    const offsetParam = list.offsetParam || 'offset';
    const step = list.offsetStep || count || 20;
    let offset = list.offsetStart ?? 0;
    for (let g = 0; g < maxPages; g++) {
      const data = await call({ ...range, ...baseParams, [offsetParam]: offset });
      const items = get(data, list.itemsPath) || [];
      const added = collect(adapter, data, seen, all);
      if (!items.length || !added) break;
      offset += step;
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

// Fetch a document's file (PDF or JSON detail) as a Blob. Accepts a doc object (preferred — carries
// `_raw`) or a bare internalId. `detail.from:'list'` uses the already-listed item's JSON as the
// document (no extra request) — ideal when the list endpoint already returns each order's data and
// there is no safe per-item endpoint. Otherwise: GET-PDF, then JSON detail, then POST-PDF.
export async function fetchDocument(adapter, auth, docOrId, net) {
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  const internalId = doc ? doc.internalId : docOrId;
  const detail = adapter.api.detail;
  if (detail && detail.from === 'list') {
    const data = doc ? (doc._raw != null ? doc._raw : doc.record || {}) : {};
    return { blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), ext: 'json', via: 'list' };
  }
  const ext = documentExt(adapter);
  if (ext === 'pdf') return { blob: await fetchPdf(adapter, auth, internalId, net), ext, via: 'pdf' };
  if (ext === 'json') return { ...(await fetchDetail(adapter, auth, internalId, net)), ext };
  throw new Error('no document for this source');
}

export async function fetchPdf(adapter, auth, internalId, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const pdf = adapter.api.pdf;
  if (!pdf) throw new Error('no PDF for this source');
  const host = pdf.host ? absHost(pdf.host) : adapter.api.host;
  const path = pdf.path.replace('{internalId}', encodeURIComponent(internalId));
  const url = host + path;
  const init = { method: pdf.method || 'GET', headers: { ...headersFor(auth, path), accept: 'application/pdf' }, credentials: 'include', wantBlob: true };
  if (init.method !== 'GET' && pdf.body != null) {
    init.body = String(pdf.body).split('{internalId}').join(internalId);
    init.headers['content-type'] = pdf.contentType || 'application/json';
  }
  const referer = pdf.referer ? String(pdf.referer).split('{internalId}').join(internalId) : null;
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) {
    const hint = res.status === 406 ? ' (sin PDF disponible — típico en tickets antiguos)' : '';
    throw new Error('pdf ' + res.status + hint + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  }
  return await res.blob();
}

const EMBED_RES = [
  /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
  /window\.__NUXT__\s*=\s*([\s\S]*?);?\s*<\/script>/i,
  /window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);?\s*<\/script>/i,
];
const stripTags = (s) => (s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// Parse HTML tables / definition lists into JSON (case: data rendered directly in a table).
function parseTables(html) {
  const out = [];
  for (const tbl of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = (tbl.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((tr) => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags)).filter((r) => r.some((c) => c));
    if (!rows.length) continue;
    if (rows.every((r) => r.length === 2)) { const o = {}; for (const [k, v] of rows) if (k) o[k] = v; out.push(o); }
    else { const head = rows[0]; out.push(rows.slice(1).map((r) => { const o = {}; head.forEach((h, i) => { if (h) o[h] = r[i]; }); return o; })); }
  }
  const dl = [...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)];
  if (dl.length) { const o = {}; for (const m of dl) { const k = stripTags(m[1]); if (k) o[k] = stripTags(m[2]); } out.push(o); }
  return out.length ? out : null;
}

const nodeSize = (v) => { if (v == null || typeof v !== 'object') return 1; let n = 1; for (const k in v) n += nodeSize(v[k]); return n; };

// Server-rendered/AJAX payloads often carry the WHOLE app state (every purchase). Narrow to the ONE
// document: the richest object that either has the id as a direct property value, or is stored under
// a key === the id (a map keyed by id). Falls back to the whole payload if the id isn't found.
export function pickDetailById(root, id) {
  if (id == null || root == null || typeof root !== 'object') return root;
  const idStr = String(id);
  let best = null, bestSize = -1;
  const consider = (node) => { if (node && typeof node === 'object' && !Array.isArray(node)) { const s = nodeSize(node); if (s > bestSize) { bestSize = s; best = node; } } };
  const visit = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (!Array.isArray(node)) {
      if (Object.keys(node).some((k) => { const v = node[k]; return v != null && typeof v !== 'object' && String(v) === idStr; })) consider(node);
      if (Object.prototype.hasOwnProperty.call(node, idStr)) consider(node[idStr]);
    }
    for (const k in node) visit(node[k]);
  };
  visit(root);
  return best || root;
}

// Detect HOW the detail delivers its data and return the extracted JSON (narrowed to `id`) + the
// mechanism: 'json' (AJAX/API), 'embedded' (JSON in the page HTML), 'table' (HTML table), 'html'.
export function extractDetail(text, url, id) {
  const t = (text || '').trim();
  let parsed, via;
  if (t[0] === '{' || t[0] === '[') { try { parsed = JSON.parse(t); via = 'json'; } catch (e) {} }
  if (parsed === undefined) {
    for (const re of EMBED_RES) { const m = re.exec(text || ''); if (m) { try { parsed = JSON.parse(m[1].trim()); via = 'embedded'; break; } catch (e) {} } }
  }
  if (parsed !== undefined) return { json: JSON.stringify(id != null ? pickDetailById(parsed, id) : parsed), via };
  const tables = parseTables(text || '');
  if (tables) return { json: JSON.stringify(tables.length === 1 ? tables[0] : tables), via: 'table' };
  return { json: JSON.stringify({ _url: url, _html: (text || '').slice(0, 300000) }), via: 'html' };
}

// Per-document JSON detail (an order's full data). Detects the delivery mechanism (AJAX JSON /
// embedded JSON / HTML table) and returns { blob, via }.
export async function fetchDetail(adapter, auth, internalId, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const d = adapter.api.detail;
  if (!d) throw new Error('no detail for this source');
  const host = d.host ? absHost(d.host) : adapter.api.host;
  const path = d.path.split('{internalId}').join(encodeURIComponent(internalId));
  const url = host + path;
  // d.headers: static headers the SPA sends for this endpoint (e.g. dkt-ecom-origin). Captured auth
  // and the accept default fill the rest; cookies ride along via credentials:'include'.
  const init = { method: d.method || 'GET', headers: { accept: 'application/json, text/html', ...(d.headers || {}), ...headersFor(auth, path.split('?')[0]) }, credentials: 'include' };
  // d.referer: some endpoints validate the Referer (e.g. the item's detail page). fetch can't set it
  // (forbidden header) → declarativeNetRequest, same as the PDF path.
  const referer = d.referer ? String(d.referer).split('{internalId}').join(internalId) : null;
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) throw new Error('detail ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  const { json, via } = extractDetail(await res.text(), url, internalId);
  return { blob: new Blob([json], { type: 'application/json' }), via };
}

async function fetchList(adapter, auth, params, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const url = adapter.api.host + adapter.api.list.path + '?' + new URLSearchParams(params);
  // Run in the site's tab (page context) so cookies + cf_clearance + fingerprint carry through and
  // Cloudflare/Akamai don't challenge it; credentials:'include' carries cookies.
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const list = adapter.api.list;
  const init = { headers: { accept: 'application/json', ...(list.headers || {}), ...headersFor(auth, list.path, !cookie) }, credentials: 'include' };
  // list.referer: some endpoints only honour the offset/page when the Referer reflects the page the
  // SPA was on. Template it per request with {from}/{offset}/{page}; set via DNR (fetch can't).
  let referer = null;
  if (list.referer) {
    const off = Number(params[list.offsetParam] ?? params[list.pageParam] ?? 0);
    const size = Number(params.size || params.count || list.offsetStep || 1) || 1;
    const page = list.pageParam ? (Number(params[list.pageParam]) || 1) : Math.floor(off / size) + 1;
    referer = String(list.referer).split('{from}').join(String(off)).split('{offset}').join(String(off)).split('{page}').join(String(page));
  }
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) throw new Error('list ' + res.status + ' — ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
  return await res.json();
}

// Map fresh items onto the shared docs array; returns how many were newly added.
function collect(adapter, data, seen, all) {
  const items = get(data, adapter.api.list.itemsPath) || [];
  const f = adapter.fields;
  let added = 0;
  for (const p of items) {
    const id = get(p, f.internalId);
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
