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
        condition: { urlFilter: (targetUrl || '').split('?')[0], resourceTypes: ['xmlhttprequest'] },
      }],
    });
  } catch (e) { return fn(); }
  try { return await fn(); }
  finally { try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch (e) {} }
}

// Enumerate a source's documents. A source with `api.groups` (e.g. a bank: many accounts) enumerates
// the groups first, then lists each group's items with {group.*} templated into the list request; each
// record carries its group (doc._group). Without groups, it's a single flat listing.
export async function listInventory(adapter, auth, net, opts) {
  const byDate = (x, y) => (x.date < y.date ? 1 : -1);
  // CSRF prelude (AEM/WiZink): fetch a page, extract the securityToken, expose it as {csrf} in every
  // subsequent list/group/pdf template via auth.__csrf.
  const a = adapter.api.csrf ? { ...(auth || {}), __csrf: await fetchCsrf(adapter, auth, net) } : auth;
  if (adapter.api.groups) {
    let groups = await listGroups(adapter, a, net);
    // opts.groupId restricts to one account (a consumer's collect{group} asks for a single account).
    if (opts && opts.groupId != null) groups = groups.filter((g) => String(g.id) === String(opts.groupId));
    const all = [];
    for (const g of groups) all.push(...await pageList(adapter, a, net, g));
    all.sort(byDate);
    return all;
  }
  const all = await pageList(adapter, a, net, null);
  all.sort(byDate);
  return all;
}

// CSRF prelude: GET a page and extract a token (e.g. WiZink's securityToken hidden input / JS var) with
// a regex (adapter.api.csrf.match, capture group 1). Reused as {csrf} in POST bodies and PDF URLs.
async function fetchCsrf(adapter, auth, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const c = adapter.api.csrf;
  const host = c.host ? absHost(c.host) : adapter.api.host;
  const url = host + c.path;
  const init = { method: c.method || 'GET', headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(c.headers || {}), ...headersFor(auth, c.path, false) }, credentials: 'include' };
  const res = await NET(url, init);
  if (!res.ok) throw new Error('csrf ' + res.status);
  const m = (await res.text()).match(new RegExp(c.match));
  return m ? m[1] : '';
}

// Enumerate the accounts/cards/portfolios a source groups its items by (id/name/… per adapter.api.groups.fields).
// Cheap — no item data. Used by the runtime (per-group listing) and by the external `listGroups` hook.
export async function listGroups(adapter, auth, net) {
  const g = adapter.api.groups;
  if (!g) return [];
  const items = await fetchGroupItems(adapter, auth, net);
  const seen = new Set(), out = [];
  for (const item of (items || [])) {
    const grp = { _raw: item };
    for (const k of Object.keys(g.fields || {})) grp[k] = get(item, g.fields[k]);
    if (grp.id != null && grp.id !== '' && seen.has(grp.id)) continue; // dedup (repeated onclick handlers per card)
    if (grp.id != null && grp.id !== '') seen.add(grp.id);
    out.push(grp);
  }
  return out;
}
async function fetchGroupItems(adapter, auth, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const g = adapter.api.groups;
  const host = g.host ? absHost(g.host) : adapter.api.host;
  const qs = g.params ? new URLSearchParams(g.params).toString() : '';
  const url = host + g.path + (qs ? '?' + qs : '');
  const isHtml = g.from === 'html';
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  const accept = isHtml ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' : 'application/json';
  const method = (g.method || 'GET').toUpperCase();
  const init = { method, headers: { accept, ...(g.headers || {}), ...headersFor(auth, g.path, !cookie) }, credentials: 'include' };
  if (method === 'POST' && g.body != null) { init.body = fillTmpl(g.body, null, auth, g.params || {}); init.headers['content-type'] = g.contentType || 'application/x-www-form-urlencoded'; }
  if (g.referer) init.referrer = g.referer;
  const res = await withReferer(url, g.referer || null, () => NET(url, init));
  if (!res.ok) throw new Error('groups ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  if (isHtml) return extractListItems(await res.text(), g); // embedded state → itemsPath
  return get(await res.json(), g.itemsPath) || [];
}

async function pageList(adapter, auth, net, group) {
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
  const call = (params) => fetchList(adapter, auth, params, net, group);

  if (paging === 'offsets') {
    let offs = { ...(list.initialOffsets || {}) };
    for (let g = 0; g < maxPages; g++) {
      const data = await call({ ...range, ...baseParams, ...offs });
      if (!collect(adapter, data, seen, all, group)) break;
      offs = Object.assign(offs, get(data, list.offsetsPath) || {});
    }
  } else if (paging === 'page') {
    const pageParam = list.pageParam || 'page';
    let page = list.pageStart ?? 1;
    for (let g = 0; g < maxPages; g++) {
      const data = await call({ ...range, ...baseParams, [pageParam]: page });
      const items = get(data, itemsPathOf(list)) || [];
      const added = collect(adapter, data, seen, all, group);
      if (!items.length || !added) break; // empty page or nothing new → done (don't stop on a short page)
      page++;
    }
  } else if (paging === 'offset') {
    const offsetParam = list.offsetParam || 'offset';
    const step = list.offsetStep || count || 20;
    let offset = list.offsetStart ?? 0;
    for (let g = 0; g < maxPages; g++) {
      const data = await call({ ...range, ...baseParams, [offsetParam]: offset });
      const items = get(data, itemsPathOf(list)) || [];
      const added = collect(adapter, data, seen, all, group);
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
      const added = collect(adapter, data, seen, all, group);
      cursor = get(data, list.nextPath);
      if (!added || !cursor) break;
    }
  } else { // 'none' — single request
    collect(adapter, await call({ ...range, ...baseParams }), seen, all, group);
  }
  return all; // sorted by the caller (listInventory) across all groups
}

const absHost = (h) => (/^https?:\/\//.test(h) ? h : 'https://' + h);
// Template an id into a path. Don't percent-encode a path/URL-like id (e.g. a row's href
// "/…/receipts/123.pdf") — that would break its slashes; encode only opaque ids.
const tid = (id) => (/[/:]/.test(String(id)) ? String(id) : encodeURIComponent(id));
// Fill a URL/referer template: {internalId} + any {dotted.path} taken from the doc's raw list item
// (e.g. Dia's detail needs {detail_params.begin}/{detail_params.pos}/… from the listed ticket).
const applyTmpl = (str, doc, id) => String(str).replace(/\{([^}]+)\}/g, (m, k) => {
  const v = k === 'internalId' ? id : (doc && doc._raw ? get(doc._raw, k) : undefined);
  return v == null ? m : tid(v);
});
// {group.field} → the current group's (e.g. bank account's) value. Templates the per-group list URL.
const tmplGroup = (str, group) => (group ? String(str).replace(/\{group\.([^}]+)\}/g, (m, k) => { const v = get(group, k); return v == null ? m : tid(v); }) : String(str));
// Fill a POST-body/URL template: {group.*} + {csrf} (the CSRF token from the prelude, on auth.__csrf) +
// any {paramName} from the request params (paging/range). Values are URL-encoded (form-urlencoded body).
function fillTmpl(str, group, auth, params) {
  let s = tmplGroup(str, group).split('{csrf}').join((auth && auth.__csrf) || '');
  for (const k of Object.keys(params || {})) s = s.split('{' + k + '}').join(params[k] == null ? '' : String(params[k]));
  return s;
}
// Unified document-URL/body templater for a doc: {internalId} + {csrf} + {group.*} (doc._group, e.g. the
// card) + {field.path} (doc._raw, e.g. the statement's statementDate). Values are URL-encoded.
function fillDocTmpl(str, doc, id, csrf) {
  return String(str).replace(/\{([^}]+)\}/g, (m, k) => {
    if (k === 'internalId') return tid(id);
    if (k === 'csrf') return csrf == null ? '' : String(csrf);
    const v = k.indexOf('group.') === 0 ? (doc && doc._group ? get(doc._group, k.slice(6)) : undefined) : (doc && doc._raw ? get(doc._raw, k) : undefined);
    return v == null ? m : tid(v);
  });
}
// Resolve a field mapping: a plain dotted path into the item, OR a template referencing {group.*}
// (and/or item fields) — e.g. account: "{group.iban}", internalId: "{group.id}-{transactionId}". A lone
// {x} preserves the raw value's type; a template with surrounding text interpolates to a string.
function resolveField(value, item, group) {
  if (typeof value !== 'string' || value.indexOf('{') < 0) return get(item, value);
  const pick = (k) => (k.indexOf('group.') === 0 ? (group ? get(group, k.slice(6)) : undefined) : get(item, k));
  const single = value.match(/^\{([^}]+)\}$/);
  if (single) return pick(single[1]);
  return value.replace(/\{([^}]+)\}/g, (m, k) => { const v = pick(k); return v == null ? '' : String(v); });
}

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
  if (detail && (detail.as === 'html' || detail.as === 'invoice' || detail.as === 'render')) return 'html'; // printable invoice
  if (pdf && (!pdf.method || pdf.method === 'GET')) return 'pdf';
  if (detail) return 'json';
  if (pdf) return 'pdf';
  return null;
}

// A clean, self-contained, printable HTML invoice generated from the receipt's detail JSON + record.
// Cross-browser (no external assets, no tab render); the user prints it to PDF. All values escaped.
const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function flattenRows(obj, prefix, depth, rows) {
  rows = rows || []; depth = depth || 0;
  if (obj == null || typeof obj !== 'object' || depth > 4) return rows;
  for (const k of Object.keys(obj)) {
    const v = obj[k], key = prefix ? prefix + ' · ' + k : k;
    if (v && typeof v === 'object') {
      if (Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object')) rows.push([key, v.join(', ')]);
      else flattenRows(v, key, depth + 1, rows);
    } else if (v !== '' && v != null) rows.push([key, v]);
  }
  return rows;
}
export function renderInvoiceHtml(doc, detail, adapter) {
  const r = (doc && doc.record) || doc || {};
  const rows = flattenRows(detail).slice(0, 200).map(([k, v]) => `<tr><td class="k">${escH(k)}</td><td>${escH(v)}</td></tr>`).join('');
  const title = `${adapter.name || adapter.service} — ${r.number || (doc && doc.internalId) || ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escH(title)}</title><style>
    body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:40px auto;color:#1a1a1a;padding:0 16px}
    h1{font-size:20px;margin:0 0 4px} .meta{color:#666;margin-bottom:10px} .total{font-size:18px;font-weight:700;margin:10px 0 18px}
    table{border-collapse:collapse;width:100%;font-size:13px} td{border-bottom:1px solid #eee;padding:6px 8px;vertical-align:top} td.k{color:#666;width:38%}
    @media print{body{margin:0}}
  </style></head><body>
    <h1>${escH(adapter.name || adapter.service)}</h1>
    <div class="meta">${r.number ? 'Nº ' + escH(r.number) : ''}${r.date ? ' · ' + escH(r.date) : ''}</div>
    ${r.total != null && r.total !== '' ? `<div class="total">${escH(r.total)} ${escH(r.currency || '')}</div>` : ''}
    <table>${rows}</table>
  </body></html>`;
}

// Two artifact kinds per document: `data` (the structured JSON detail) and `document` (the
// presentable file — rendered/print HTML or PDF). A source can produce either or BOTH; a sink chooses
// which to take (sink.accepts.artifacts). `api.detail` (plain) = data; `api.document` (as:render|
// html|invoice) or `api.pdf` = document; a legacy `api.detail.as` counts as the document.
const docExtOf = (cfg) => (cfg.as === 'render' || cfg.as === 'html' || cfg.as === 'invoice' ? 'html' : 'pdf');
const documentCfg = (api) => api.document || (api.detail && api.detail.as ? api.detail : null);
// True unless a {field.path} placeholder (other than {internalId}) is missing from this doc's raw item.
// Lets a per-doc-conditional artifact (Dia's invoice PDF needs {invoices.0}) be skipped for docs that
// don't have it (a ticket with no invoice) instead of firing a malformed request.
function tmplResolvable(str, doc) {
  for (const m of String(str || '').matchAll(/\{([^}]+)\}/g)) {
    const k = m[1];
    if (k === 'internalId' || k === 'csrf') continue; // always available at fetch time
    const v = k.indexOf('group.') === 0 ? (doc && doc._group ? get(doc._group, k.slice(6)) : undefined) : (doc && doc._raw ? get(doc._raw, k) : undefined);
    if (v == null || v === '') return false;
  }
  return true;
}
// Which artifacts this source produces. With a `doc`, drops any document whose template fields the doc
// can't fill (e.g. a Dia ticket without an associated invoice) — no artifact, no error.
export function artifactKinds(adapter, doc) {
  const api = adapter.api || {}, out = [];
  if (api.detail && !api.detail.as) out.push({ kind: 'data', ext: 'json' });
  const dc = documentCfg(api);
  if (dc) { if (!doc || tmplResolvable(dc.path, doc)) out.push({ kind: 'document', ext: docExtOf(dc) }); }
  else if (api.pdf) { if (!doc || tmplResolvable(api.pdf.path, doc)) out.push({ kind: 'document', ext: api.pdf.ext || 'pdf' }); }
  return out;
}
// Fetch one artifact. Reuses fetchDocument by PROJECTING the adapter so the requested artifact sits
// on api.detail/api.pdf (no change to the low-level fetchers).
export async function fetchArtifact(adapter, auth, doc, net, render, kind) {
  const api = adapter.api;
  if (kind === 'data') {
    const a = { ...adapter, api: { ...api, detail: api.detail, pdf: undefined, document: undefined } };
    const r = await fetchDocument(a, auth, doc, net, render);
    return { kind, ext: 'json', blob: r.blob, via: r.via };
  }
  const dc = documentCfg(api);
  const a = dc ? { ...adapter, api: { ...api, detail: dc, pdf: undefined } } : { ...adapter, api: { ...api, detail: undefined } };
  const r = await fetchDocument(a, auth, doc, net, render);
  return { kind, ext: r.ext, blob: r.blob, via: r.via };
}

// Fetch a document's file (PDF or JSON detail) as a Blob. Accepts a doc object (preferred — carries
// `_raw`) or a bare internalId. `detail.from:'list'` uses the already-listed item's JSON as the
// document (no extra request) — ideal when the list endpoint already returns each order's data and
// there is no safe per-item endpoint. Otherwise: GET-PDF, then JSON detail, then POST-PDF.
export async function fetchDocument(adapter, auth, docOrId, net, render) {
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  const internalId = doc ? doc.internalId : docOrId;
  const detail = adapter.api.detail;
  if (detail && detail.from === 'list') {
    const data = doc ? (doc._raw != null ? doc._raw : doc.record || {}) : {};
    return { blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), ext: 'json', via: 'list' };
  }
  if (detail && detail.as === 'render') { // render the SPA page in a tab, capture the FINAL DOM, self-contain it
    if (!render) throw new Error('rendering needs a tab — open the site and retry');
    const host = detail.host ? absHost(detail.host) : adapter.api.host;
    const url = host + detail.path.split('{internalId}').join(tid(internalId));
    const html = await inlineAssets(await render(url, { waitFor: detail.waitFor, waitMs: detail.waitMs }), url, net || ((u, i) => fetch(u, i)));
    return { blob: new Blob([html], { type: 'text/html' }), ext: 'html', via: 'render' };
  }
  if (detail && detail.as === 'html') return fetchHtmlDoc(adapter, auth, internalId, net); // fetch the print page, self-contained
  if (detail && detail.as === 'invoice') { // render a clean printable invoice from the detail JSON
    const dj = await fetchDetail(adapter, auth, doc || internalId, net);
    let data = {}; try { data = JSON.parse(await dj.blob.text()); } catch (e) {}
    return { blob: new Blob([renderInvoiceHtml(doc || { internalId }, data, adapter)], { type: 'text/html' }), ext: 'html', via: 'invoice' };
  }
  const ext = documentExt(adapter);
  if (ext === 'pdf') return { blob: await fetchPdf(adapter, auth, doc || internalId, net), ext: adapter.api.pdf.ext || 'pdf', via: 'pdf' };
  if (ext === 'json') return { ...(await fetchDetail(adapter, auth, doc || internalId, net)), ext };
  throw new Error('no document for this source');
}

export async function fetchPdf(adapter, auth, docOrId, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  const internalId = doc ? doc.internalId : docOrId;
  const pdf = adapter.api.pdf;
  if (!pdf) throw new Error('no PDF for this source');
  const host = pdf.host ? absHost(pdf.host) : adapter.api.host;
  // WiZink's securityToken is single-use/short-lived — the prelude token is stale by download time.
  // Refresh it right before each document fetch so the download carries a valid {csrf}.
  let csrf = auth && auth.__csrf;
  if (adapter.api.csrf) { try { csrf = await fetchCsrf(adapter, auth, net); } catch (e) {} }
  const path = fillDocTmpl(pdf.path, doc, internalId, csrf); // {internalId} + {field.path} + {group.*} + {csrf}
  // A leftover {field} means this doc can't fill the template (e.g. a ticket with no invoice) — no
  // document for it. Bail cleanly (callers treat it as "artifact unavailable") instead of a bad request.
  if (/\{[^}]+\}/.test(path)) throw new Error('no document for this item');
  const url = host + path;
  // accept:*/* not application/pdf — some servers (Dia's invoice endpoint) return 204 No Content for a
  // bare application/pdf Accept but serve the real PDF for the browser-default */*.
  const init = { method: pdf.method || 'GET', headers: { accept: '*/*', ...(pdf.headers || {}), ...headersFor(auth, path.split('?')[0]) }, credentials: 'include', wantBlob: true };
  if (init.method !== 'GET' && pdf.body != null) {
    init.body = fillDocTmpl(pdf.body, doc, internalId, csrf);
    init.headers['content-type'] = pdf.contentType || 'application/json';
  }
  const referer = pdf.referer ? fillDocTmpl(pdf.referer, doc, internalId, csrf) : null;
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
// Fetch an HTML document (e.g. hover's server-rendered receipt/print page) and make it self-contained:
// inline its stylesheets and images so it renders offline and prints to PDF anywhere (cross-browser,
// no tab render). A <base> covers anything not inlined.
async function toDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(s)}`;
}
async function inlineAssets(html, baseUrl, NET) {
  let base; try { base = new URL(baseUrl); } catch (e) { return html; }
  const abs = (u) => { try { return new URL(u, base).href; } catch (e) { return null; } };
  let budget = 25; // cap fetched assets
  for (const m of [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]) {
    if (budget-- <= 0) break;
    const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1]; const u = href && abs(href);
    if (!u) continue;
    try { const css = await (await NET(u, { credentials: 'include' })).text(); html = html.replace(m[0], `<style>${css}</style>`); } catch (e) {}
  }
  for (const m of [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]) {
    if (budget-- <= 0) break;
    const u = abs(m[1]); if (!u || /^data:/i.test(m[1])) continue;
    try { const du = await toDataUrl(await (await NET(u, { credentials: 'include', wantBlob: true })).blob()); html = html.split('"' + m[1] + '"').join('"' + du + '"').split("'" + m[1] + "'").join("'" + du + "'"); } catch (e) {}
  }
  if (!/<base\b/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (h) => h + `<base href="${base.origin}/">`);
  return html;
}
async function fetchHtmlDoc(adapter, auth, internalId, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const d = adapter.api.detail;
  const host = d.host ? absHost(d.host) : adapter.api.host;
  const path = d.path.split('{internalId}').join(tid(internalId));
  const url = host + path;
  const init = { headers: { accept: 'text/html', ...(d.headers || {}), ...headersFor(auth, path.split('?')[0]) }, credentials: 'include' };
  const referer = d.referer ? String(d.referer).split('{internalId}').join(internalId) : null;
  if (referer) init.referrer = referer;
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) throw new Error('detail ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  const html = await inlineAssets(await res.text(), url, NET);
  return { blob: new Blob([html], { type: 'text/html' }), ext: 'html', via: 'page' };
}

export async function fetchDetail(adapter, auth, docOrId, net) {
  const NET = net || ((u, i) => fetch(u, i));
  const doc = docOrId && typeof docOrId === 'object' ? docOrId : null;
  const internalId = doc ? doc.internalId : docOrId;
  const d = adapter.api.detail;
  if (!d) throw new Error('no detail for this source');
  const host = d.host ? absHost(d.host) : adapter.api.host;
  const path = applyTmpl(d.path, doc, internalId); // {internalId} + {field.path} from the list item
  const url = host + path;
  // d.headers: static headers the SPA sends for this endpoint (e.g. dkt-ecom-origin). Captured auth
  // and the accept default fill the rest; cookies ride along via credentials:'include'.
  const init = { method: d.method || 'GET', headers: { accept: 'application/json, text/html', ...(d.headers || {}), ...headersFor(auth, path.split('?')[0]) }, credentials: 'include' };
  // d.referer: some endpoints validate the Referer (e.g. the item's detail page). fetch can't set it
  // (forbidden header) → declarativeNetRequest, same as the PDF path.
  const referer = d.referer ? applyTmpl(d.referer, doc, internalId) : null;
  if (referer) init.referrer = referer; // page-context fetch sets it same-origin (reliable); DNR is the fallback
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) throw new Error('detail ' + res.status + ' ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120));
  const { json, via } = extractDetail(await res.text(), url, internalId);
  return { blob: new Blob([json], { type: 'application/json' }), via };
}

async function fetchList(adapter, auth, params, net, group) {
  const NET = net || ((u, i) => fetch(u, i));
  const list = adapter.api.list;
  const html = list.from === 'html';
  // {group.*} in the list path / param values / referer → the account (group) currently being listed.
  const path = tmplGroup(list.path, group);
  const gparams = {}; for (const k of Object.keys(params || {})) gparams[k] = tmplGroup(params[k], group);
  const qs = new URLSearchParams(gparams).toString();
  const url = adapter.api.host + path + (qs ? '?' + qs : '');
  // Run in the site's tab (page context) so cookies + cf_clearance + fingerprint carry through and
  // Cloudflare/Akamai don't challenge it; credentials:'include' carries cookies.
  const cookie = adapter.auth && adapter.auth.mode === 'cookie';
  // A bare `accept: text/html` can trip content negotiation (Dia returns 204 No Content for it); send the
  // full browser navigation Accept so the server serves the real SSR page.
  const htmlAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const method = (list.method || 'GET').toUpperCase();
  const init = { method, headers: { accept: html ? htmlAccept : 'application/json', ...(list.headers || {}), ...headersFor(auth, path.split('?')[0], !cookie) }, credentials: 'include' };
  // POST list (AEM/WiZink send params in the body): fill {group.*} + {csrf} (from the prelude) + {paramName}.
  if (method === 'POST' && list.body != null) {
    init.body = fillTmpl(list.body, group, auth, gparams);
    init.headers['content-type'] = list.contentType || 'application/x-www-form-urlencoded';
  }
  // list.referer: some endpoints only honour the offset/page when the Referer reflects the page the
  // SPA was on. Template it per request with {from}/{offset}/{page} (+ {group.*}); set via DNR (fetch can't).
  let referer = null;
  if (list.referer) {
    const off = Number(params[list.offsetParam] ?? params[list.pageParam] ?? 0);
    const size = Number(params.size || params.count || list.offsetStep || 1) || 1;
    const page = list.pageParam ? (Number(params[list.pageParam]) || 1) : Math.floor(off / size) + 1;
    referer = tmplGroup(String(list.referer).split('{from}').join(String(off)).split('{offset}').join(String(off)).split('{page}').join(String(page)), group);
  }
  if (referer) init.referrer = referer; // same-origin referer set from the tab; DNR is the fallback
  const res = await withReferer(url, referer, () => NET(url, init));
  if (!res.ok) throw new Error('list ' + res.status + ' — ' + (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
  // Server-rendered list (no JSON API): parse the items out of the page HTML.
  if (html) return { __items: extractListItems(await res.text(), list) };
  return await res.json();
}

// Extract list items from a server-rendered page: embedded JSON at `itemsPath`, else the rows of the
// (largest) HTML table — each row → an object keyed by column header, plus `href` of its link(s).
export function extractListItems(html, list) {
  if (list.rows) return parseHtmlItems(html || '', list.rows); // repeated-block extraction (AEM/WiZink)
  if (list.itemsPath) {
    for (const obj of embeddedObjects(html || '')) {
      const arr = get(obj, list.itemsPath);
      if (Array.isArray(arr)) return arr;
    }
  }
  return parseHtmlRows(html || '');
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Extract records from repeated HTML blocks that aren't a clean table/JSON — e.g. WiZink's AEM movements.
// cfg = { row: 'movement-item', fields: { date:{sel:'movement-date'}, total:{sel:'movement-amount'},
//   concept:{tag:'h4'}, category:{attr:'data-category'}, id:{re:'movItem_(\\d+)'} } }. A row spans from one
// `row` class marker to the next; a field is the first element carrying a class (sel) / a tag / an attribute / a regex group.
export function parseHtmlItems(html, cfg) {
  if (!cfg) return [];
  // `each` regex mode: each match is a row; fields map to capture groups ({group:1}) or sub-extract from m[0].
  if (cfg.each) {
    const re = new RegExp(cfg.each, 'g'), out = []; let m;
    while ((m = re.exec(html || ''))) {
      const o = {}; for (const k of Object.keys(cfg.fields || {})) { const f = cfg.fields[k]; o[k] = f.group != null ? (m[f.group] || '') : extractField(m[0], f); }
      out.push(o);
    }
    return out;
  }
  if (!cfg.row) return [];
  const re = new RegExp('class=["\'][^"\']*\\b' + escapeRe(cfg.row) + '\\b', 'g');
  const idx = []; let m; while ((m = re.exec(html || ''))) idx.push(m.index);
  const req = cfg.require ? (Array.isArray(cfg.require) ? cfg.require : [cfg.require]) : [];
  const out = [];
  for (let i = 0; i < idx.length; i++) {
    const block = String(html).slice(idx[i], i + 1 < idx.length ? idx[i + 1] : undefined);
    const o = {}; for (const k of Object.keys(cfg.fields || {})) o[k] = extractField(block, cfg.fields[k]);
    if (req.every((k) => o[k] != null && o[k] !== '')) out.push(o); // drop header/summary rows missing required fields
  }
  return out;
}
function extractField(block, s) {
  try {
    if (s.re) { const m = block.match(new RegExp(s.re, 'i')); return m ? String(m[1] != null ? m[1] : m[0]).trim() : ''; }
    if (s.attr) { const m = block.match(new RegExp(escapeRe(s.attr) + '\\s*=\\s*["\']([^"\']*)["\']', 'i')); return m ? m[1].trim() : ''; }
    if (s.tag) { const m = block.match(new RegExp('<' + s.tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + s.tag + '>', 'i')); return m ? stripTags(m[1]) : ''; }
    if (s.sel) { const m = block.match(new RegExp('class=["\'][^"\']*\\b' + escapeRe(s.sel) + '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)<', 'i')); return m ? stripTags(m[1]) : ''; }
  } catch (e) {}
  return '';
}
const unescapeHtml = (s) => String(s).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Bootstrap JSON embedded in a page: <script> blobs (Next/Nuxt/JSON-LD) AND React/Inertia
// `data-props`/`data-page`/`data-state` attributes (HTML-entity escaped) — hover.com uses the latter.
export function embeddedObjects(html) {
  const out = [], H = html || '';
  const push = (s) => { try { out.push(JSON.parse(String(s).trim())); } catch (e) {} };
  // ALL <script type="application/json"> blocks (Next, JSON-LD, Vike's vike_pageContext, …), not just
  // the first — so itemsPath can pick the right one when a page has several.
  for (const m of H.matchAll(/<script\b[^>]*\btype=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) push(m[1]);
  for (const m of H.matchAll(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)) push(m[1]);
  for (const m of H.matchAll(/window\.__(?:NUXT|INITIAL_STATE)__\s*=\s*([\s\S]*?);?\s*<\/script>/gi)) push(m[1]);
  for (const m of H.matchAll(/data-(?:props|page|state)=(['"])([\s\S]*?)\1/gi)) push(unescapeHtml(m[2]));
  return out;
}
function parseHtmlRows(html) {
  const tables = (html.match(/<table[\s\S]*?<\/table>/gi) || []).sort((a, b) => b.length - a.length);
  const tbl = tables[0];
  if (!tbl) return [];
  const trs = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  if (trs.length < 2) return [];
  const head = (trs[0].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
  const out = [];
  for (let i = 1; i < trs.length; i++) {
    const cells = trs[i].match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
    if (!cells.length) continue;
    const o = {};
    cells.forEach((c, k) => { o[head[k] || 'col' + k] = stripTags(c); });
    const hrefs = [...trs[i].matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
    if (hrefs.length) { o.href = hrefs[0]; o.hrefs = hrefs; }
    out.push(o);
  }
  return out;
}
const itemsPathOf = (list) => (list.from === 'html' ? '__items' : list.itemsPath);

// Normalize a date value to ISO (YYYY-MM-DD). Handles ISO/ISO-datetime, epoch s/ms, textual months
// (English + Spanish, "October 22, 2021" / "22 de octubre de 2021"), and D/M/Y numeric — so lists
// sort correctly and records are consistent. Unparseable → returned unchanged.
const MONTHS = {};
[['january', 'jan', 'enero', 'ene'], ['february', 'feb', 'febrero'], ['march', 'mar', 'marzo'],
  ['april', 'apr', 'abril', 'abr'], ['may', 'mayo'], ['june', 'jun', 'junio'], ['july', 'jul', 'julio'],
  ['august', 'aug', 'agosto', 'ago'], ['september', 'sep', 'sept', 'septiembre', 'setiembre'],
  ['october', 'oct', 'octubre'], ['november', 'nov', 'noviembre'], ['december', 'dec', 'diciembre', 'dic'],
].forEach((names, i) => names.forEach((n) => { MONTHS[n] = i + 1; }));
const pad2 = (n) => String(n).padStart(2, '0');
export function normalizeDate(v) {
  if (v == null || v === '') return v;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d{10,13}$/.test(s)) { const n = Number(s); const d = new Date(n < 1e12 ? n * 1000 : n); if (!isNaN(+d)) return d.toISOString().slice(0, 10); }
  const low = s.toLowerCase();
  m = low.match(/\b([a-záéíóúñ]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/); // Month DD, YYYY
  if (m && MONTHS[m[1]]) return `${m[3]}-${pad2(MONTHS[m[1]])}-${pad2(m[2])}`;
  m = low.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+)?([a-záéíóúñ]{3,})\.?\s+(?:de\s+)?(\d{4})\b/); // DD [de] Month [de] YYYY
  if (m && MONTHS[m[2]]) return `${m[3]}-${pad2(MONTHS[m[2]])}-${pad2(m[1])}`;
  m = s.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/); // numeric D/M/Y, M/D/Y or Y/M/D
  if (m) {
    if (m[1].length === 4) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
    const a = +m[1], b = +m[2], y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    const day = a > 12 ? a : (b > 12 ? b : a), mon = a > 12 ? b : (b > 12 ? a : b); // D/M unless clearly M/D
    return `${y}-${pad2(mon)}-${pad2(day)}`;
  }
  m = low.match(/^(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]{3,})\.?$/); // DD MON (no year) — WiZink movements; infer year
  if (m && MONTHS[m[2]]) {
    const now = new Date(), mon = MONTHS[m[2]];
    let y = now.getFullYear();
    if (new Date(Date.UTC(y, mon - 1, +m[1])).getTime() - now.getTime() > 7 * 86400000) y -= 1; // future → last year
    return `${y}-${pad2(mon)}-${pad2(+m[1])}`;
  }
  const d = new Date(s); return isNaN(+d) ? s : d.toISOString().slice(0, 10);
}

// Spanish/EUR amount text → number. "21,00 €" → 21 · "1.234,56 €" → 1234.56 · "-5,00"/"5,00-" → -5.
export function normalizeAmount(v) {
  if (v == null || v === '' || typeof v === 'number') return v;
  let s = String(v).replace(/[\s ]|€|eur/gi, '');
  if (!s) return v;
  const neg = /^-|-$|^\(|\)$/.test(s);
  s = s.replace(/[()+\-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'); // strip thousands '.', decimal ','→'.'
  const n = parseFloat(s);
  return isNaN(n) ? v : (neg ? -n : n);
}

// Map fresh items onto the shared docs array; returns how many were newly added.
function collect(adapter, data, seen, all, group) {
  const items = get(data, itemsPathOf(adapter.api.list)) || [];
  const f = adapter.fields;
  let added = 0;
  for (const p of items) {
    const id = resolveField(f.internalId, p, group); // may be templated with {group.*} for cross-group uniqueness
    if (id != null && seen.has(id)) continue;
    if (id != null) seen.add(id);
    all.push(mapDoc(adapter, p, group)); added++;
  }
  return added;
}

function mapDoc(adapter, p, group) {
  const f = adapter.fields, doc = { _raw: p };
  if (group) doc._group = group; // the parent (account) this record belongs to
  for (const k in f) doc[k] = resolveField(f[k], p, group);
  if (doc.date != null && doc.date !== '') doc.date = normalizeDate(doc.date); // textual/locale → ISO
  for (const k of ['total', 'amount']) if (typeof doc[k] === 'string' && doc[k] !== '') doc[k] = normalizeAmount(doc[k]); // "21,00 €" → 21
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
  // Accept days / months / years — e.g. "90d" (WiZink: only the last 90 days need no extra auth), "6m", "3y".
  const m = /^(\d+)\s*([dmy])$/.exec(String(w || '3y').trim());
  const n = m ? +m[1] : 3, unit = m ? m[2] : 'y';
  const days = unit === 'd' ? n : unit === 'm' ? n * 30 : n * 365;
  return days * 24 * 3600 * 1000;
}
