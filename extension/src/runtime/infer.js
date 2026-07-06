// Record-mode inference — turn observed network samples into an adapter DRAFT the user then
// confirms in the visual mapper. Pure and deterministic (no I/O), so it is unit-testable.
//
// A "sample" is { url, method, status, reqHeaders, json } captured in-session by the learn-mode
// hook. We pick the response that looks like a document list (the biggest array of objects),
// locate it (itemsPath), guess pagination, and guess the field mapping. Everything is a guess the
// user can override; nothing here is trusted blindly.

// Flatten an object's leaf + shallow-object keys to dotted paths with a sample value.
export function flattenKeys(obj, prefix = '', depth = 2, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    const path = prefix ? prefix + '.' + k : k;
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && depth > 0) flattenKeys(v, path, depth - 1, out);
    else if (typeof v !== 'object' || v === null) out.push({ path, value: v });
  }
  return out;
}

// Find every array-of-objects inside a response, with its dotted path and length.
function findArrays(node, path, acc) {
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === 'object' && node[0] !== null && !Array.isArray(node[0])) acc.push({ path, len: node.length, sample: node[0], arr: node });
    return acc;
  }
  if (node && typeof node === 'object') for (const k of Object.keys(node)) findArrays(node[k], path ? path + '.' + k : k, acc);
  return acc;
}

// Does any leaf value in `node` contain the (lowercased) needle?
function deepIncludes(node, needle, depth = 6) {
  if (node == null || depth < 0) return false;
  if (typeof node === 'object') { for (const k in node) if (deepIncludes(node[k], needle, depth - 1)) return true; return false; }
  return String(node).toLowerCase().includes(needle);
}

// Find which captured list(s) contain a value the user recognises (a ticket number, an amount…).
// Lets a non-technical user identify the right request without understanding endpoints.
export function matchCandidates(samples, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return collect(samples)
    .filter((c) => c.items.some((it) => deepIncludes(it, q)))
    .map((c) => ({ key: c.key, url: c.s.url, itemsPath: c.itemsPath, count: c.len, pages: c.pages }));
}

// Depth-first search for the first path whose leaf key matches a regex (returns dotted path).
function findKeyPath(node, re, path = '', depth = 3) {
  if (!node || typeof node !== 'object' || depth < 0) return null;
  for (const k of Object.keys(node)) {
    const p = path ? path + '.' + k : k;
    if (re.test(k)) return p;
    const sub = findKeyPath(node[k], re, p, depth - 1);
    if (sub) return sub;
  }
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}|\d{2}[/-]\d{2}[/-]\d{4}/;
const looksDate = (k, v) => /date|fecha|timestamp|_at$|dia/i.test(k) || (typeof v === 'string' && DATE_RE.test(v));
const looksMoney = (k) => /(total|amount|importe|price|precio|value|importe|gross|net|due)/i.test(k);
const looksId = (k) => /(^id$|_id$|id$|number|numero|reference|referencia|uuid|code|codigo)/i.test(k);
const looksName = (k) => /(store|shop|merchant|comercio|tienda|name|nombre|supplier|proveedor|seller|counterparty|instrument|concept|concepto|description|descripcion)/i.test(k);

const HEADER_ALLOW = /^(authorization|x-.*token|x-.*csrf|x-xsrf-token|requestorigin|sessionid)$/i;

// App-specific request headers (e.g. dkt-ecom-origin) that a request needs but that aren't auth
// (auth is replayed via auth.replayHeaders) — carried into list.headers / detail.headers de oficio.
function appHeaders(reqHeaders) {
  const out = {};
  for (const k of Object.keys(reqHeaders || {})) {
    if (HEADER_ALLOW.test(k)) continue; // auth handled separately (auth.replayHeaders)
    if (reqHeaders[k]) out[k] = reqHeaders[k]; // includes content-type — some GET APIs require it
  }
  return out;
}
// The full navigated-page URL that carries `id` (the item's detail page) → a referer template.
function refererForId(domTexts, id) {
  for (const d of domTexts || []) { if (d && d.url && String(d.url).includes(id)) return String(d.url).split(id).join('{internalId}'); }
  return null;
}

// A logical list is identified by host + endpoint path + itemsPath — the SAME list across pages
// (different offset/page/cursor in the query) collapses to one candidate.
function keyOf(url, itemsPath) {
  try { const u = new URL(url); return u.host + u.pathname + '#' + itemsPath; } catch (e) { return url + '#' + itemsPath; }
}

// Every array-of-objects found across the captured samples, grouped by logical list. Items from all
// captured PAGES of the same list are aggregated (deduped), so `count` = how many distinct items you
// browsed (not one page), and detail/PDF inference can match an id from any visited page. A
// representative sample (the largest page) is kept for URL / pagination / auth inference.
function collect(samples) {
  const byKey = new Map();
  for (const s of samples || []) {
    if (!s || !s.json || (s.status && s.status >= 300)) continue;
    for (const a of findArrays(s.json, '', [])) {
      const key = keyOf(s.url, a.path);
      let e = byKey.get(key);
      if (!e) { e = { key, s, itemsPath: a.path, items: [], seen: new Set(), pages: new Set(), pageSamples: [], repLen: 0 }; byKey.set(key, e); }
      if (!e.pages.has(s.url)) { e.pages.add(s.url); e.pageSamples.push({ url: s.url, json: s.json }); } // each captured page
      for (const it of a.arr) { const k = JSON.stringify(it); if (!e.seen.has(k)) { e.seen.add(k); e.items.push(it); } }
      if (a.len > e.repLen) { e.repLen = a.len; e.s = s; } // largest page → best for paging/url/params
    }
  }
  return [...byKey.values()]
    .map((e) => ({ key: e.key, s: e.s, itemsPath: e.itemsPath, len: e.items.length, pages: e.pages.size, item: e.items[0], items: e.items, samples: e.pageSamples }))
    .sort((x, y) => y.len - x.len);
}

// Public: the candidate lists for the picker UI.
export function listCandidates(samples) {
  return collect(samples).map((c) => {
    let host = '', path = '';
    try { const u = new URL(c.s.url); host = u.host; path = u.pathname; } catch (e) {}
    return { key: c.key, url: c.s.url, host, path, itemsPath: c.itemsPath, count: c.len, pages: c.pages, keys: Object.keys(c.item || {}) };
  });
}

function getPath(obj, path) {
  if (obj == null || path == null) return undefined;
  if (String(path).indexOf('.') < 0) return obj[path];
  return String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// Map each item field's value (as a string) to its dotted field path. Used to discover which field
// is the INTERNAL id — the one whose value actually appears in the detail/PDF URL — as opposed to a
// human-facing receipt/invoice number that only shows in the data.
function valueFields(items) {
  const map = new Map();
  for (const it of (items || []).slice(0, 50)) {
    for (const f of flattenKeys(it)) {
      const v = f.value;
      if (v == null || v === '') continue;
      const s = String(v);
      if (s.length >= 3 && !map.has(s)) map.set(s, f.path);
    }
  }
  return map;
}

// The per-document DETAIL endpoint. Two sources: a captured XHR JSON response whose URL+body carry a
// document id, OR a PAGE the user navigated to whose URL carries the id (server-rendered detail —
// fetchDetail then extracts the embedded JSON). The id may sit in the PATH or a QUERY param
// (Decathlon: orderTracking?transactionId=<uuid>). `idField` = the item field the URL uses (the
// internal id), so the draft templates by THAT, not a guessed public number.
export function inferDetail(samples, items, domTexts) {
  const vf = valueFields(items);
  if (!vf.size) return null;
  const vals = [...vf.keys()].sort((a, b) => b.length - a.length);
  const full = (u) => u.pathname + (u.search || '');
  const templ = (u, id) => full(u).split(id).join('{internalId}');

  // Prefer a real XHR JSON endpoint (the SPA's per-item data call) — auto-carry its app headers and
  // the detail-page URL as the Referer (both often required, e.g. Decathlon's order endpoint).
  for (const s of samples || []) {
    if (!s || !s.json || Array.isArray(s.json) || (s.status && s.status >= 300)) continue;
    let u; try { u = new URL(s.url); } catch (e) { continue; }
    const id = vals.find((v) => full(u).includes(v) && deepIncludes(s.json, v.toLowerCase()));
    if (id) return { host: u.host, path: templ(u, id), method: (s.method || 'GET').toUpperCase(), idField: vf.get(id), headers: appHeaders(s.reqHeaders), referer: refererForId(domTexts, id) };
  }
  // Fallback: a server-rendered detail page the user opened (URL carries the id) — no XHR captured.
  for (const d of domTexts || []) {
    let u; try { u = new URL(d.url); } catch (e) { continue; }
    const id = vals.find((v) => full(u).includes(v));
    if (id) return { host: u.host, path: templ(u, id), method: 'GET', idField: vf.get(id), referer: String(d.url).split(id).join('{internalId}') };
  }
  return null;
}

// The PDF endpoint, from captured document (asset) requests. Handles GET .../{id}/pdf, POST-generated
// PDFs (body templated by id), and a Referer requirement. Also returns the URL `idField`.
export function inferPdf(assets, items) {
  const vf = valueFields(items);
  const vals = [...vf.keys()].sort((a, b) => b.length - a.length);
  for (const a of assets || []) {
    let u; try { u = new URL(a.url); } catch (e) { continue; }
    const id = vals.find((v) => u.pathname.includes(v) || String(a.reqBody || '').includes(v));
    const pdf = { method: (a.method || 'GET').toUpperCase(), path: u.pathname };
    if (id && u.pathname.includes(id)) pdf.path = u.pathname.split(id).join('{internalId}');
    if (pdf.method !== 'GET' && a.reqBody) { pdf.body = id ? String(a.reqBody).split(id).join('{internalId}') : String(a.reqBody); if (a.reqType) pdf.contentType = a.reqType; }
    if (a.referer && id && a.referer.includes(id)) pdf.referer = a.referer.split(id).join('{internalId}');
    return { host: u.host, pdf, idField: id ? vf.get(id) : undefined };
  }
  return null;
}

// Dotted path to the first leaf whose value equals `val` (used to find where a cursor comes from).
function pathOfValue(node, val, path = '', depth = 6) {
  if (node == null || depth < 0) return null;
  if (typeof node !== 'object') return String(node) === String(val) ? path : null;
  for (const k of Object.keys(node)) { const p = pathOfValue(node[k], val, path ? path + '.' + k : k, depth - 1); if (p) return p; }
  return null;
}
// Given several captured pages of the SAME list, the cursor param's value on one page is produced by
// the previous page's response — find that response path (= nextPath).
function cursorSourcePath(pageSamples, param) {
  const vals = pageSamples.map((p) => { try { return new URL(p.url).searchParams.get(param); } catch (e) { return null; } }).filter((v) => v != null && v !== '');
  for (const p of pageSamples) for (const v of vals) { const path = pathOfValue(p.json, v); if (path) return path; }
  return null;
}

// Deduce pagination. If several pages were captured, LEARN it by seeing which query param changes and
// how (1,2,3 → page · 0,N,2N → offset · a changing token → cursor). Otherwise fall back to single-page
// signals (a cursor/offsets object in the response, or a `page`-like param).
function deducePaging(best, s, u) {
  const pages = (best.samples || []).map((p) => { let uu; try { uu = new URL(p.url); } catch (e) { return null; } return uu; }).filter(Boolean);
  if (pages.length >= 2) {
    const keys = new Set(); pages.forEach((pu) => { for (const k of pu.searchParams.keys()) keys.add(k); });
    for (const k of keys) {
      const distinct = new Set(pages.map((pu) => pu.searchParams.get(k)));
      if (distinct.size < 2) continue; // constant across pages → not the pagination param
      const nums = [...distinct].filter((v) => v != null && v !== '').map(Number);
      if (nums.length >= 2 && nums.every((n) => Number.isFinite(n))) {
        const sorted = [...new Set(nums)].sort((a, b) => a - b);
        const step = sorted[1] - sorted[0];
        if (step > 0 && sorted.every((n, i) => i === 0 || n - sorted[i - 1] === step)) {
          return step === 1
            ? { paging: 'page', list: { pageParam: k, pageStart: sorted[0] } }
            // Start from the beginning (offset 0), not the smallest captured offset — the user may
            // have browsed pages 2,3… so page 1 (from=0) wasn't among the samples.
            : { paging: 'offset', list: { offsetParam: k, offsetStart: 0, offsetStep: step } };
        }
      }
      const nextPath = cursorSourcePath(best.samples, k); // a token whose source is a response field
      if (nextPath) return { paging: 'cursor', list: { cursorParam: k, nextPath } };
    }
  }
  const nextPath = findKeyPath(s.json, /(nextcursor|next_cursor|next|cursor|continuation)/i);
  if (nextPath) return { paging: 'cursor', list: { nextPath, cursorParam: 'cursor' } };
  const offsetsKey = Object.keys(s.json).find((k) => /offset/i.test(k) && s.json[k] && typeof s.json[k] === 'object');
  if (offsetsKey) return { paging: 'offsets', list: { offsetsPath: offsetsKey, initialOffsets: {} } };
  const pageParam = [...u.searchParams.keys()].find((k) => /^(page|pagina|pagenumber|pageno|p)$/i.test(k));
  if (pageParam) return { paging: 'page', list: { pageParam, pageStart: 1 } };
  const pageMeta = findKeyPath(s.json, /(totalpages|pagecount|page_count|total_pages|pagenumber)/i);
  if (pageMeta) return { paging: 'page', list: { pageParam: 'page', pageStart: 1 } };
  return { paging: 'none', list: {} };
}

// Build an adapter draft. `ctx` = { domain, pageHost, assets }. `chosen` (optional) = { key }
// picks a specific captured list; without it the biggest is used.
export function draftAdapterFromSamples(samples, ctx = {}, chosen = null) {
  const cand = collect(samples);
  if (!cand.length) return { ok: false, reason: 'no list-like response captured' };
  let best = cand[0];
  if (chosen) { const f = cand.find((c) => (chosen.key ? c.key === chosen.key : c.s.url === chosen.url && c.itemsPath === chosen.itemsPath)); if (f) best = f; }
  const s = best.s;
  const u = new URL(s.url);
  const host = u.host;
  const item = best.item;

  // Pagination — learned from the multiple captured pages when possible.
  const { paging, list } = deducePaging(best, s, u);

  // Field guesses. Use the RENDERED page text (if captured) to tell a public receipt/invoice number
  // (visible to the user) from an internal id (only in URLs/traffic): the internal one is internalId,
  // the visible one maps to `number`.
  const flat = flattenKeys(item);
  const domText = (ctx.domTexts || []).map((d) => (typeof d === 'string' ? d : (d && d.text) || '')).join('\n').toLowerCase();
  const visible = (v) => v != null && v !== '' && String(v).length >= 3 && domText.includes(String(v).toLowerCase());
  const pick = (test) => { const f = flat.find(({ path, value }) => test(path.split('.').pop(), value)); return f && f.path; };
  const fields = {};
  const idFields = flat.filter((f) => looksId(f.path.split('.').pop()) && f.value != null && f.value !== '');
  const internalId = idFields.find((f) => !visible(f.value)) || idFields[0];
  fields.internalId = (internalId && internalId.path) || (flat[0] && flat[0].path);
  const publicNo = idFields.find((f) => visible(f.value) && (!internalId || f.path !== internalId.path));
  if (publicNo) fields.number = publicNo.path;
  fields.date = pick(looksDate) || '';
  const money = pick((k) => looksMoney(k));
  if (money) fields.total = money;
  const name = pick((k) => looksName(k));
  if (name) fields.storeName = name;

  // Auth model: bearer (replay the captured JWT) vs cookie (rely on the browser's cookies via
  // credentials:'include'; replay any csrf/origin headers the SPA also sent).
  const reqHeaders = s.reqHeaders || {};
  const hasBearer = /eyJ/.test(reqHeaders.authorization || '');
  const captured = Object.keys(reqHeaders).filter((h) => HEADER_ALLOW.test(h) && h !== 'content-type');
  const auth = hasBearer
    ? { mode: 'bearer', tokenMatch: 'eyJ', replayHeaders: captured.includes('authorization') ? captured : ['authorization', ...captured] }
    : { mode: 'cookie', replayHeaders: captured.filter((h) => h !== 'authorization') };

  const domain = ctx.domain || host.split('.').slice(-2).join('.');
  const pageHost = ctx.pageHost || domain;
  const service = domain.split('.')[0];
  const draft = {
    id: domain.replace(/\./g, '-'),
    name: service.charAt(0).toUpperCase() + service.slice(1) + ' — documents',
    service,
    trust: 'community',
    domain,
    categories: ['other'],
    match: [u.protocol + '//' + pageHost + '/*'],
    auth,
    api: {
      host: u.protocol + '//' + host,
      list: Object.assign({ path: u.pathname, paging, itemsPath: best.itemsPath || 'items' }, list),
    },
    fields,
    schema: 'receipt@1',
  };
  // Static query params captured from the sample, MINUS the pagination cursor/page/offset (so the
  // pager starts from the beginning even if the chosen page was mid-list). Page-size params stay.
  const params = {};
  const stripKeys = new Set();
  if (paging === 'page' && list.pageParam) stripKeys.add(list.pageParam.toLowerCase());
  if (paging === 'offset' && list.offsetParam) stripKeys.add(list.offsetParam.toLowerCase());
  if (paging === 'cursor' && list.cursorParam) stripKeys.add(list.cursorParam.toLowerCase());
  for (const [k, v] of u.searchParams) {
    const kl = k.toLowerCase();
    if (stripKeys.has(kl)) continue;
    if (paging === 'offsets' && /offset/.test(kl)) continue;
    params[k] = v;
  }
  if (Object.keys(params).length) draft.api.list.params = params;

  // De oficio: carry the list request's app headers (e.g. dkt-ecom-origin) and, if a paged account
  // page was navigated, a per-page Referer template (some endpoints only honour the offset then).
  const lh = appHeaders(s.reqHeaders);
  if (Object.keys(lh).length) draft.api.list.headers = lh;
  const pageRef = (ctx.domTexts || []).find((d) => { try { const uu = new URL(d.url); return uu.host === host && /[?&]page=\d+/.test(uu.search); } catch (e) { return false; } });
  if (pageRef) draft.api.list.referer = String(pageRef.url).replace(/([?&]page=)\d+/, '$1{page}');

  // Per-document artifact: prefer the JSON detail (captured passively when the user opens an order);
  // fall back to a captured PDF request. Auto-carry the detail's app headers + detail-page Referer.
  const detail = inferDetail(samples, best.items, ctx.domTexts);
  if (detail) {
    draft.api.detail = { path: detail.path, method: detail.method };
    if (detail.host && detail.host !== host) draft.api.detail.host = detail.host;
    if (detail.headers && Object.keys(detail.headers).length) draft.api.detail.headers = detail.headers;
    if (detail.referer) draft.api.detail.referer = detail.referer;
    if (detail.idField) fields.internalId = detail.idField; // the internal id used in the URL
  } else if (ctx.assets) {
    const p = inferPdf(ctx.assets, best.items);
    if (p) { draft.api.pdf = p.pdf; if (p.host && p.host !== host) draft.api.pdf.host = p.host; if (p.idField) fields.internalId = p.idField; }
  }

  // The list array's field candidates power the visual mapper dropdowns.
  return { ok: true, draft, fieldCandidates: flat, itemsPath: best.itemsPath, host, count: best.len };
}
