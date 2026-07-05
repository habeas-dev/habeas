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
      if (!e) { e = { key, s, itemsPath: a.path, items: [], seen: new Set(), pages: new Set(), repLen: 0 }; byKey.set(key, e); }
      e.pages.add(s.url); // distinct pages captured for this list
      for (const it of a.arr) { const k = JSON.stringify(it); if (!e.seen.has(k)) { e.seen.add(k); e.items.push(it); } }
      if (a.len > e.repLen) { e.repLen = a.len; e.s = s; } // largest page → best for paging/url/params
    }
  }
  return [...byKey.values()]
    .map((e) => ({ key: e.key, s: e.s, itemsPath: e.itemsPath, len: e.items.length, pages: e.pages.size, item: e.items[0], items: e.items }))
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
  const templ = (u, id) => full(u).split(id).join('{externalId}');

  for (const s of samples || []) {
    if (!s || !s.json || Array.isArray(s.json) || (s.status && s.status >= 300)) continue;
    let u; try { u = new URL(s.url); } catch (e) { continue; }
    const id = vals.find((v) => full(u).includes(v) && deepIncludes(s.json, v.toLowerCase()));
    if (id) return { host: u.host, path: templ(u, id), method: (s.method || 'GET').toUpperCase(), idField: vf.get(id) };
  }
  // Server-rendered detail page the user opened (URL carries the id) — no XHR JSON captured.
  for (const d of domTexts || []) {
    let u; try { u = new URL(d.url); } catch (e) { continue; }
    const id = vals.find((v) => full(u).includes(v));
    if (id) return { host: u.host, path: templ(u, id), method: 'GET', idField: vf.get(id) };
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
    if (id && u.pathname.includes(id)) pdf.path = u.pathname.split(id).join('{externalId}');
    if (pdf.method !== 'GET' && a.reqBody) { pdf.body = id ? String(a.reqBody).split(id).join('{externalId}') : String(a.reqBody); if (a.reqType) pdf.contentType = a.reqType; }
    if (a.referer && id && a.referer.includes(id)) pdf.referer = a.referer.split(id).join('{externalId}');
    return { host: u.host, pdf, idField: id ? vf.get(id) : undefined };
  }
  return null;
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

  // Pagination guess from the winning response.
  const nextPath = findKeyPath(s.json, /(nextcursor|next_cursor|next|cursor|continuation)/i);
  const offsetsKey = Object.keys(s.json).find((k) => /offset/i.test(k) && s.json[k] && typeof s.json[k] === 'object');
  let paging = 'none', list = {};
  if (nextPath) { paging = 'cursor'; list.nextPath = nextPath; list.cursorParam = 'cursor'; }
  else if (offsetsKey) { paging = 'offsets'; list.offsetsPath = offsetsKey; list.initialOffsets = {}; }
  else {
    // Page pagination: a `page`-like query param, or a page-count field in the response.
    const pageParam = [...u.searchParams.keys()].find((k) => /^(page|pagina|pagenumber|pageno|p)$/i.test(k));
    const pageMeta = findKeyPath(s.json, /(totalpages|pagecount|page_count|total_pages|pagenumber)/i);
    if (pageParam) { paging = 'page'; list.pageParam = pageParam; list.pageStart = 1; }
    else if (pageMeta) { paging = 'page'; list.pageParam = 'page'; list.pageStart = 1; }
  }

  // Field guesses. Use the RENDERED page text (if captured) to tell a public receipt/invoice number
  // (visible to the user) from an internal id (only in URLs/traffic): the internal one is externalId,
  // the visible one maps to `number`.
  const flat = flattenKeys(item);
  const domText = (ctx.domTexts || []).map((d) => (typeof d === 'string' ? d : (d && d.text) || '')).join('\n').toLowerCase();
  const visible = (v) => v != null && v !== '' && String(v).length >= 3 && domText.includes(String(v).toLowerCase());
  const pick = (test) => { const f = flat.find(({ path, value }) => test(path.split('.').pop(), value)); return f && f.path; };
  const fields = {};
  const idFields = flat.filter((f) => looksId(f.path.split('.').pop()) && f.value != null && f.value !== '');
  const internalId = idFields.find((f) => !visible(f.value)) || idFields[0];
  fields.externalId = (internalId && internalId.path) || (flat[0] && flat[0].path);
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
  if (paging === 'cursor' && list.cursorParam) stripKeys.add(list.cursorParam.toLowerCase());
  for (const [k, v] of u.searchParams) {
    const kl = k.toLowerCase();
    if (stripKeys.has(kl)) continue;
    if (paging === 'offsets' && /offset/.test(kl)) continue;
    params[k] = v;
  }
  if (Object.keys(params).length) draft.api.list.params = params;

  // Per-document artifact: prefer the JSON detail (captured passively when the user opens an order);
  // fall back to a captured PDF request.
  const detail = inferDetail(samples, best.items, ctx.domTexts);
  if (detail) {
    draft.api.detail = { path: detail.path, method: detail.method };
    if (detail.host && detail.host !== host) draft.api.detail.host = detail.host;
    if (detail.idField) fields.externalId = detail.idField; // the internal id used in the URL
  } else if (ctx.assets) {
    const p = inferPdf(ctx.assets, best.items);
    if (p) { draft.api.pdf = p.pdf; if (p.host && p.host !== host) draft.api.pdf.host = p.host; if (p.idField) fields.externalId = p.idField; }
  }

  // The list array's field candidates power the visual mapper dropdowns.
  return { ok: true, draft, fieldCandidates: flat, itemsPath: best.itemsPath, host, count: best.len };
}
