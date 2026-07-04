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
    if (node.length && typeof node[0] === 'object' && node[0] !== null && !Array.isArray(node[0])) acc.push({ path, len: node.length, sample: node[0] });
    return acc;
  }
  if (node && typeof node === 'object') for (const k of Object.keys(node)) findArrays(node[k], path ? path + '.' + k : k, acc);
  return acc;
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

// Build an adapter draft. `ctx` = { domain, pageHost }.
export function draftAdapterFromSamples(samples, ctx = {}) {
  const cand = [];
  for (const s of samples || []) {
    if (!s || !s.json || (s.status && s.status >= 300)) continue;
    for (const a of findArrays(s.json, '', [])) cand.push({ ...a, sample: a.sample, s });
  }
  if (!cand.length) return { ok: false, reason: 'no list-like response captured' };
  cand.sort((x, y) => y.len - x.len);
  const best = cand[0];
  const s = best.s;
  const u = new URL(s.url);
  const host = u.host;
  const item = best.sample;

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
    match: ['https://' + pageHost + '/*'],
    auth: { tokenMatch: 'eyJ', replayHeaders },
    api: {
      host: 'https://' + host,
      list: Object.assign({ path: u.pathname, paging, itemsPath: best.path || 'items' }, list),
    },
    fields,
    schema: 'receipt@1',
  };
  // Static query params captured from the sample (user can trim in the mapper).
  const params = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  if (Object.keys(params).length) draft.api.list.params = params;

  // The list array's field candidates power the visual mapper dropdowns.
  return { ok: true, draft, fieldCandidates: flat, itemsPath: best.path, host, count: best.len };
}
