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
  const byKey = new Map();
  for (const s of samples || []) {
    if (!s || !s.json) continue;
    for (const a of findArrays(s.json, '', [])) {
      if (!a.arr.some((it) => deepIncludes(it, q))) continue;
      const key = keyOf(s.url, a.path);
      const prev = byKey.get(key);
      if (!prev || a.len > prev.count) byKey.set(key, { key, url: s.url, itemsPath: a.path, count: a.len });
    }
  }
  return [...byKey.values()].sort((x, y) => y.count - x.count);
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

// Every array-of-objects found across the captured samples, deduped by logical list (keeping the
// largest page as representative), biggest first. The biggest isn't always the right one → the UI
// lets the user pick / search.
function collect(samples) {
  const byKey = new Map();
  for (const s of samples || []) {
    if (!s || !s.json || (s.status && s.status >= 300)) continue;
    for (const a of findArrays(s.json, '', [])) {
      const key = keyOf(s.url, a.path);
      const c = { key, s, itemsPath: a.path, len: a.len, item: a.sample };
      const prev = byKey.get(key);
      if (!prev || c.len > prev.len) byKey.set(key, c);
    }
  }
  return [...byKey.values()].sort((x, y) => y.len - x.len);
}

// Public: the candidate lists for the picker UI.
export function listCandidates(samples) {
  return collect(samples).map((c) => {
    let host = '', path = '';
    try { const u = new URL(c.s.url); host = u.host; path = u.pathname; } catch (e) {}
    return { key: c.key, url: c.s.url, host, path, itemsPath: c.itemsPath, count: c.len, keys: Object.keys(c.item || {}) };
  });
}

// Build an adapter draft. `ctx` = { domain, pageHost }. `chosen` (optional) = { url, itemsPath }
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

  // Field guesses.
  const flat = flattenKeys(item);
  const pick = (test) => { const f = flat.find(({ path, value }) => test(path.split('.').pop(), value)); return f && f.path; };
  const fields = {};
  fields.externalId = pick((k) => looksId(k)) || (flat[0] && flat[0].path);
  fields.date = pick(looksDate) || '';
  const money = pick((k) => looksMoney(k));
  if (money) fields.total = money;
  const name = pick((k) => looksName(k));
  if (name) fields.storeName = name;

  // Auth headers to replay: whatever we captured on the winning request.
  const reqHeaders = s.reqHeaders || {};
  const replayHeaders = Object.keys(reqHeaders).filter((h) => HEADER_ALLOW.test(h));
  if (!replayHeaders.includes('authorization')) replayHeaders.unshift('authorization');

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
    auth: { tokenMatch: 'eyJ', replayHeaders },
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

  // The list array's field candidates power the visual mapper dropdowns.
  return { ok: true, draft, fieldCandidates: flat, itemsPath: best.itemsPath, host, count: best.len };
}
