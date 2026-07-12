// Record-mode inference — turn observed network samples into an adapter DRAFT the user then
// confirms in the visual mapper. Pure and deterministic (no I/O), so it is unit-testable.
//
// A "sample" is { url, method, status, reqHeaders, json } captured in-session by the learn-mode
// hook. We pick the response that looks like a document list (the biggest array of objects),
// locate it (itemsPath), guess pagination, and guess the field mapping. Everything is a guess the
// user can override; nothing here is trusted blindly.
//
// Two families of samples are handled: JSON responses (the classic SPA-API case) and HTML samples
// — an AJAX endpoint that returns an HTML table fragment, OR the whole server-rendered (SSR) page
// captured as `kind:'html'`. For HTML we detect the repeated row structure and draft a `from:'html'`
// list with a declarative `rows` config that the runtime's `parseHtmlItems` consumes AS-IS.
import { parseHtmlItems } from './inventory.js';

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
  const json = collect(samples)
    .filter((c) => c.items.some((it) => deepIncludes(it, q)))
    .map((c) => ({ key: c.key, url: c.s.url, itemsPath: c.itemsPath, count: c.len, pages: c.pages }));
  const html = collectHtml(samples)
    .filter((c) => c.items.some((it) => Object.values(it).some((v) => String(v).toLowerCase().includes(q))))
    .map((c) => ({ key: c.key, url: c.s.url, itemsPath: '', count: c.len, pages: 1 }));
  return [...json, ...html];
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
    const v = reqHeaders[k];
    if (!v) continue;
    // Skip ephemeral/session tokens (e.g. anti-bot like `uzlc`): long, token-shaped, no spaces.
    // Hardcoding them breaks on rotation and isn't publishable — capture live via replayHeaders instead.
    if (String(v).length > 40 && /^[A-Za-z0-9._~:+/=-]+$/.test(String(v))) continue;
    out[k] = v; // config-ish headers (dkt-ecom-origin, content-type) — safe to carry
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
      if (!e) { e = { key, s, itemsPath: a.path, items: [], seen: new Set(), pages: new Set(), pageSamples: [], repLen: 0, fromHtml: false }; byKey.set(key, e); }
      if (!e.pages.has(s.url)) { e.pages.add(s.url); e.pageSamples.push({ url: s.url, json: s.json }); } // each captured page
      e.fromHtml = e.fromHtml || !!s.fromHtml; // the array came from embedded page state (SSR), not an XHR
      for (const it of a.arr) { const k = JSON.stringify(it); if (!e.seen.has(k)) { e.seen.add(k); e.items.push(it); } }
      if (a.len > e.repLen) { e.repLen = a.len; e.s = s; } // largest page → best for paging/url/params
    }
  }
  return [...byKey.values()]
    .map((e) => ({ key: e.key, s: e.s, itemsPath: e.itemsPath, len: e.items.length, pages: e.pages.size, item: e.items[0], items: e.items, samples: e.pageSamples, fromHtml: e.fromHtml }))
    .sort((x, y) => y.len - x.len);
}

// ---------------------------------------------------------------------------------------------
// HTML inference (SSR pages / AJAX-that-returns-HTML). Heuristic and deliberately scoped to the
// common "table of documents with a per-row PDF" shape (the Bip&Drive case). Exotic layouts are
// left unhandled with a TODO rather than mis-drafted.
// ---------------------------------------------------------------------------------------------
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
// A single capturing group each — reused verbatim inside the generated `each` regex string.
const H_DATE = '([0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\\s+(?:de\\s+)?[A-Za-zÁÉÍÓÚáéíóúñ]{3,}\\.?(?:\\s+(?:de\\s+)?[0-9]{4})?)';
const H_MONEY = '([0-9][0-9.,]*\\s*(?:€|EUR|\\$|£))';
const H_MONEY_NOCAP = '(?:[0-9][0-9.,]*\\s*(?:€|EUR|\\$|£))';
const H_DATE_RE = /([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\s+(?:de\s+)?[A-Za-zÁÉÍÓÚáéíóúñ]{3,}\.?(?:\s+(?:de\s+)?[0-9]{4})?)/;
const H_MONEY_RE = /[0-9][0-9.,]*\s*(?:€|EUR|\$|£)/i;
const GAP = '[\\s\\S]{0,2500}?';
const mode = (arr) => { const m = {}; let best = null, bn = 0; for (const x of arr) { m[x] = (m[x] || 0) + 1; if (m[x] > bn) { bn = m[x]; best = x; } } return best; };
const htmlBody = (s) => (s && (s.kind === 'html' || typeof s.html === 'string') ? s.html : null);

// The largest <table> (by row count) and its rows. Most services render "one document per <tr>".
function largestTable(html) {
  const tables = (String(html || '').match(/<table[\s\S]*?<\/table>/gi) || [])
    .map((t) => ({ html: t, trs: t.match(/<tr[\s\S]*?<\/tr>/gi) || [] }))
    .sort((a, b) => b.trs.length - a.trs.length);
  return tables[0] || null;
}
function rowCells(tr) {
  return [...String(tr).matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
    .map((m) => ({ tag: m[1].toLowerCase(), attrs: m[2] || '', inner: m[3] || '', text: stripHtml(m[3]), offset: m.index }));
}
// A class token shaped like `veh_mat_0` → its stable base `veh_mat` (the `_N` suffix varies per row).
function suffixClassBase(attrs) {
  const cm = /class=["']([^"']+)["']/i.exec(attrs || '');
  if (!cm) return null;
  for (const tok of cm[1].split(/\s+/)) { const t = /^([A-Za-z][\w-]*?)_(\d+)$/.exec(tok); if (t) return t[1]; }
  return null;
}
// Class-anchored field extractor: `veh_mat_\d+ … > <capture>` — robust across rows (the digit varies).
const classAnchor = (base, cap) => escRe(base) + '_\\d+\\b[^>]*>\\s*' + cap;

// Infer a `rows` config + a PDF endpoint from one HTML body. Returns null when no table-of-rows is
// found (caller logs & skips — see TODO for non-table repeated blocks).
function inferHtmlRows(html) {
  const H = String(html || '');
  const tbl = largestTable(H);
  if (!tbl || tbl.trs.length < 2) return null; // TODO: repeated non-<table> blocks (cards/list items)
  const dataTrs = tbl.trs.filter((tr) => !/<th\b/i.test(tr) && (H_DATE_RE.test(stripHtml(tr)) || H_MONEY_RE.test(stripHtml(tr))));
  if (!dataTrs.length) return null;
  const rep = dataTrs.find((tr) => H_DATE_RE.test(stripHtml(tr))) || dataTrs[0];
  const cells = rowCells(rep);

  // Row anchor: prefer a shared numeric-suffix class on the <tr> (veh_0/veh_1…); else any <tr>.
  const rowBases = dataTrs.map((tr) => suffixClassBase((/<tr\b([^>]*)>/i.exec(tr) || [])[1])).filter(Boolean);
  const rowBase = rowBases.length ? mode(rowBases) : null;
  const rowAnchor = rowBase ? '<tr\\b[^>]*\\b' + escRe(rowBase) + '_\\d+' : '<tr\\b[^>]*>';

  const fields = []; // { name, offset, anchor } — anchor has exactly ONE capture group

  // Date — required. Anchor on the cell's suffix-class when it has one, else capture the first date.
  const dateCell = cells.find((c) => H_DATE_RE.test(c.text));
  if (!dateCell) return null;
  const dBase = suffixClassBase(dateCell.attrs);
  fields.push({ name: 'date', offset: dateCell.offset, anchor: dBase ? classAnchor(dBase, H_DATE) : H_DATE });

  // Total — the LAST money cell in the row (base/tax precede it). Anchor on its class when distinctive,
  // else (one money cell) capture it directly, else skip the earlier money cells to reach the last.
  const moneyCells = cells.filter((c) => H_MONEY_RE.test(c.text));
  if (moneyCells.length) {
    const totalCell = moneyCells[moneyCells.length - 1];
    const tBase = suffixClassBase(totalCell.attrs);
    let anchor;
    if (tBase) anchor = classAnchor(tBase, H_MONEY);
    else if (moneyCells.length === 1) anchor = H_MONEY;
    else anchor = '(?:' + H_MONEY_NOCAP + '[\\s\\S]*?){' + (moneyCells.length - 1) + '}' + H_MONEY;
    fields.push({ name: 'total', offset: totalCell.offset, anchor });
  }

  // Public number — a title="CI…" attribute (the human-facing invoice/ticket number). Prefix-anchored.
  const titleCell = cells.find((c) => {
    const tv = (/title=["']([^"']+)["']/i.exec(c.attrs) || [])[1] || '';
    return /^[A-Za-z]{1,4}[\w-]*\d/.test(tv);
  });
  if (titleCell) {
    const tv = (/title=["']([^"']+)["']/i.exec(titleCell.attrs) || [])[1] || '';
    const prefix = (tv.match(/^[A-Za-z]+/) || [''])[0];
    fields.push({ name: 'number', offset: titleCell.offset, anchor: 'title="(' + escRe(prefix) + '[^"]*)"' });
  }

  // PDF: a <form> whose submit downloads a PDF (hidden inputs → templated body), else a <a href="*.pdf">.
  let pdf = null;
  const formM = /<form\b[^>]*>[\s\S]*?<\/form>/i.exec(rep);
  const linkM = /<a\b[^>]*href=["']([^"']*\.pdf[^"']*)["']/i.exec(rep);
  if (formM) {
    const form = formM[0];
    const action = (/action=["']([^"']*)["']/i.exec(form) || [])[1] || '';
    const bodyParts = [];
    for (const m of form.matchAll(/<input\b([^>]*)>/gi)) {
      const a = m[1];
      const name = (/name=["']([^"']+)["']/i.exec(a) || [])[1];
      const value = (/value=["']([^"']*)["']/i.exec(a) || [])[1];
      if (!name || value == null) continue;
      const nameFirst = a.search(/name=/i) < a.search(/value=/i);
      const anchor = nameFirst
        ? 'name="' + escRe(name) + '"[^>]*?value="([^"]+)"'
        : 'value="([^"]+)"[^>]*?name="' + escRe(name) + '"';
      // Offset within the representative row: form start + the input's position inside the form.
      fields.push({ name, offset: formM.index + Math.max(0, form.search(new RegExp('name=["\']' + escRe(name))), form.indexOf(m[0])), anchor });
      bodyParts.push(name + '={' + name + '}'); // captured per-row → templated into the POST body
    }
    // Submit button/input (e.g. name="tipo" value="PDF") → a constant in the body.
    for (const bm of [...form.matchAll(/<button\b([^>]*)>/gi), ...form.matchAll(/<input\b([^>]*type=["']submit["'][^>]*)>/gi)]) {
      const a = bm[1];
      const name = (/name=["']([^"']+)["']/i.exec(a) || [])[1];
      const value = (/value=["']([^"']*)["']/i.exec(a) || [])[1];
      if (name && value != null) bodyParts.push(name + '=' + value);
    }
    pdf = { path: action && action !== '.' ? action : '/', method: 'POST', body: bodyParts.join('&'), ext: 'pdf' };
  } else if (linkM) {
    fields.push({ name: 'href', offset: rep.indexOf(linkM[0]), anchor: 'href=["\']([^"\']*\\.pdf[^"\']*)["\']' });
    pdf = { path: '{internalId}', method: 'GET', ext: 'pdf' };
  }

  // Assemble the `each` regex in DOM order; each field owns the i-th capture group.
  fields.sort((a, b) => a.offset - b.offset);
  const each = rowAnchor + fields.map((f) => GAP + f.anchor).join('');
  const rowsFields = {};
  fields.forEach((f, i) => { rowsFields[f.name] = { group: i + 1 }; });
  const rows = { each, fields: rowsFields };

  // Validate the generated regex against the SAME html via the real runtime parser (no fork). If it
  // yields nothing, the heuristic failed — bail so we never emit a broken source.
  let items = [];
  try { items = parseHtmlItems(H, rows); } catch (e) { return null; }
  if (!items.length) return null;

  const has = (n) => fields.some((f) => f.name === n);
  const internalId = has('href') ? 'href' : has('number') ? 'number' : has('id_factura') ? 'id_factura' : 'date';
  return { rows, pdf, items, internalId, hasNumber: has('number'), hasTotal: has('total') };
}

// Page/offset paging for an HTML list: from a `page`-like query param OR (AJAX POST) request body.
function deduceHtmlPaging(u, reqBody, method) {
  const PAGE_KEY = /^(page|pagina|pag|pageno|pagenumber|p)$/i;
  const OFFSET_KEY = /^(offset|start|from)$/i;
  for (const [k, v] of u.searchParams) {
    if (PAGE_KEY.test(k) && /^\d+$/.test(v)) return { paging: 'page', list: { pageParam: k, pageStart: Number(v) || 1 } };
    if (OFFSET_KEY.test(k) && /^\d+$/.test(v)) return { paging: 'offset', list: { offsetParam: k, offsetStart: 0 } };
  }
  if (reqBody && /=/.test(reqBody)) {
    for (const [k, v] of new URLSearchParams(reqBody)) {
      if (PAGE_KEY.test(k) && /^\d+$/.test(v)) {
        const body = reqBody.replace(new RegExp('(^|&)(' + escRe(k) + ')=[^&]*'), (m, pre, key) => pre + key + '={' + key + '}');
        return { paging: 'page', list: { pageParam: k, pageStart: Number(v) || 1 }, body };
      }
    }
  }
  return { paging: 'none', list: {} };
}

// Every HTML sample that yields a usable rows config, as a candidate (mirrors collect()'s shape).
function collectHtml(samples) {
  const out = [];
  for (const s of samples || []) {
    const html = htmlBody(s);
    if (!html) continue;
    let info; try { info = inferHtmlRows(html); } catch (e) { info = null; }
    if (!info || !info.items.length) continue;
    let host = '', path = '';
    try { const u = new URL(s.url); host = u.host; path = u.pathname; } catch (e) {}
    out.push({ isHtml: true, key: keyOf(s.url, '#html'), s, host, path, info, len: info.items.length, item: info.items[0], items: info.items });
  }
  return out.sort((a, b) => b.len - a.len);
}

// Build an adapter draft from a chosen HTML candidate. Same return shape as the JSON path.
function draftHtml(best, ctx = {}) {
  const s = best.s, info = best.info;
  let u; try { u = new URL(s.url); } catch (e) { return { ok: false, reason: 'bad url' }; }
  const host = u.host;
  const domain = ctx.domain || host.split('.').slice(-2).join('.');
  const pageHost = ctx.pageHost || domain;
  const service = domain.split('.')[0];

  // Cookie auth (HTML pages ride the browser session); replay any csrf/origin headers the SPA sent.
  const reqHeaders = s.reqHeaders || {};
  const captured = Object.keys(reqHeaders).filter((h) => HEADER_ALLOW.test(h) && h !== 'content-type' && h !== 'authorization');
  const auth = { mode: 'cookie', replayHeaders: captured };

  const method = (s.method || 'GET').toUpperCase();
  const list = { from: 'html', path: u.pathname, paging: 'none', rows: info.rows };
  if (method !== 'GET') list.method = method;
  const pg = deduceHtmlPaging(u, s.reqBody, method);
  Object.assign(list, pg.list);
  list.paging = pg.paging;
  if (pg.body != null) list.body = pg.body;
  else if (method !== 'GET' && s.reqBody) list.body = s.reqBody;

  const schema = /factura|invoice/i.test(s.html) ? 'invoice@1' : (/ticket|recibo|receipt/i.test(s.html) ? 'receipt@1' : 'invoice@1');
  const fields = { internalId: info.internalId, date: 'date' };
  if (info.hasNumber) fields.number = 'number';
  if (info.hasTotal) fields.total = 'total';

  const draft = {
    id: domain.replace(/\./g, '-'),
    name: service.charAt(0).toUpperCase() + service.slice(1) + ' — documents',
    service,
    trust: 'community',
    domain,
    categories: ['other'],
    match: [u.protocol + '//' + pageHost + '/*'],
    auth,
    api: { host: u.protocol + '//' + host, list },
    fields,
    schema,
  };
  if (info.pdf) draft.api.pdf = info.pdf;

  const fieldCandidates = Object.keys(best.item || {}).map((k) => ({ path: k, value: best.item[k] }));
  return { ok: true, draft, fieldCandidates, itemsPath: 'HTML rows', host, count: best.len };
}

// Public: the candidate lists for the picker UI (JSON + HTML), biggest first.
export function listCandidates(samples) {
  const json = collect(samples).map((c) => {
    let host = '', path = '';
    try { const u = new URL(c.s.url); host = u.host; path = u.pathname; } catch (e) {}
    return { key: c.key, url: c.s.url, host, path, itemsPath: c.itemsPath, count: c.len, pages: c.pages, keys: Object.keys(c.item || {}) };
  });
  const html = collectHtml(samples).map((c) => ({ key: c.key, url: c.s.url, host: c.host, path: c.path, itemsPath: '', count: c.len, pages: 1, keys: Object.keys(c.item || {}), html: true }));
  return [...json, ...html].sort((a, b) => (b.count || 0) - (a.count || 0));
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
// Find the dotted path in an item whose LEAF key === paramName and whose value === paramValue.
// Correlates a detail-URL query param (begin/pos/store…) to the list item's field that feeds it —
// works even for short values (pos=2) that valueFields skips, because the param name disambiguates.
function fieldByKeyVal(item, key, val) {
  for (const f of flattenKeys(item, '', 6)) {
    if (f.path.split('.').pop().toLowerCase() === String(key).toLowerCase() && String(f.value) === String(val)) return f.path;
  }
  return null;
}

export function inferDetail(samples, items, domTexts) {
  const vf = valueFields(items);
  if (!vf.size) return null;
  const vals = [...vf.keys()].sort((a, b) => b.length - a.length);
  const full = (u) => u.pathname + (u.search || '');
  // Template the id (path or query) as {internalId} AND every OTHER query param whose value comes from
  // the same item (matched by param name + value) as {field.path} — so detail endpoints that need
  // per-item params (Dia: begin/pos/store/country/business) are reproduced, not frozen to one ticket.
  const templ = (u, id, item) => {
    const path0 = u.pathname.split(id).join('{internalId}');
    const parts = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (v === id) { parts.push(k + '={internalId}'); continue; }
      const fp = item ? fieldByKeyVal(item, k, v) : null;
      parts.push(k + '=' + (fp ? '{' + fp + '}' : v));
    }
    return path0 + (u.search ? '?' + parts.join('&') : '');
  };
  const itemFor = (id) => (items || []).find((it) => String(getPath(it, vf.get(id))) === String(id)) || (items || [])[0];

  // Prefer a real XHR JSON endpoint (the SPA's per-item data call) — auto-carry its app headers and
  // the detail-page URL as the Referer (both often required, e.g. Decathlon's order endpoint).
  for (const s of samples || []) {
    if (!s || !s.json || Array.isArray(s.json) || s.fromHtml || (s.status && s.status >= 300)) continue;
    let u; try { u = new URL(s.url); } catch (e) { continue; }
    const id = vals.find((v) => full(u).includes(v) && deepIncludes(s.json, v.toLowerCase()));
    if (id) return { host: u.host, path: templ(u, id, itemFor(id)), method: (s.method || 'GET').toUpperCase(), idField: vf.get(id), headers: appHeaders(s.reqHeaders), referer: refererForId(domTexts, id) };
  }
  // Fallback: a server-rendered detail page the user opened (URL carries the id) — no XHR captured.
  for (const d of domTexts || []) {
    let u; try { u = new URL(d.url); } catch (e) { continue; }
    const id = vals.find((v) => full(u).includes(v));
    if (id) return { host: u.host, path: templ(u, id, itemFor(id)), method: 'GET', idField: vf.get(id), referer: String(d.url).split(id).join('{internalId}') };
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

// ---------------------------------------------------------------------------------------------
// CSRF prelude inference. Some sites (AEM/WiZink) require a per-session securityToken scraped from a
// page the SPA loaded first, then sent in the POST body of the data request. Detect a token in the
// list body that ALSO appears verbatim in a captured HTML page → emit api.csrf so the runtime fetches
// a FRESH token each run (the captured one is stale next session), and template the body as {csrf}.
// The runtime only injects {csrf} into bodies/URLs (never replayed headers), so this targets the body.
// ---------------------------------------------------------------------------------------------
function walkStrings(node, add, depth = 6) {
  if (node == null || depth < 0) return;
  if (typeof node === 'string') return add(node);
  if (typeof node === 'object') for (const k of Object.keys(node)) walkStrings(node[k], add, depth - 1);
}
// Token-shaped string values in a POST body (JSON leaves or form values): long, opaque, no spaces.
function bodyTokens(body) {
  const out = new Set();
  const add = (v) => { const s = String(v); if (s.length >= 16 && /^[A-Za-z0-9._-]+$/.test(s)) out.add(s); };
  let parsed = false;
  try { walkStrings(JSON.parse(body), add); parsed = true; } catch (e) {}
  if (!parsed) { try { for (const [, v] of new URLSearchParams(body)) add(v); } catch (e) {} }
  return [...out];
}
const csrfCharClass = (tok) => '[A-Za-z0-9' + (tok.includes('_') ? '_' : '') + (tok.includes('-') ? '\\-' : '') + (tok.includes('.') ? '.' : '') + ']';
// A regex that captures `tok` from `html`. Prefer a semantic anchor near the value (securityToken /
// *_csrf / *_token); fall back to the literal bytes right before it. Only returned if it re-extracts
// the exact token — so we never emit a broken prelude.
function buildCsrfRegex(html, tok) {
  const idx = html.indexOf(tok);
  if (idx < 0) return null;
  const cls = csrfCharClass(tok);
  const before = html.slice(Math.max(0, idx - 60), idx);
  const cands = [];
  const names = [...before.matchAll(/([A-Za-z_][\w-]*(?:token|csrf|xsrf|nonce))/gi)].map((m) => m[1]);
  if (names.length) cands.push(escRe(names[names.length - 1]) + '["\'\\s]*(?:value=|content=|:|=)?["\'\\s]*(' + cls + '{12,})');
  cands.push(escRe(html.slice(Math.max(0, idx - 20), idx)) + '(' + cls + '{12,})'); // literal-context fallback
  for (const rx of cands) { try { const m = new RegExp(rx).exec(html); if (m && m[1] === tok) return rx; } catch (e) {} }
  return null;
}
function inferCsrf(body, samples) {
  if (!body) return null;
  const htmls = (samples || []).map((s) => ({ s, html: htmlBody(s) })).filter((x) => x.html);
  if (!htmls.length) return null;
  for (const tok of bodyTokens(body)) {
    for (const { s, html } of htmls) {
      if (!html.includes(tok)) continue;
      const match = buildCsrfRegex(html, tok);
      if (!match) continue;
      let u; try { u = new URL(s.url); } catch (e) { continue; }
      return { host: u.host, path: u.pathname, match, tok };
    }
  }
  return null;
}

// Body-based pagination: a page/offset field lives INSIDE the POST body (a form field, or a nested
// GraphQL variable like variables.skip) rather than the query string. Template that field so the
// runtime's pager fills it each page. Returns { body, paging, list } or null. Only page/offset (a
// body cursor is response-derived and handled by the cursor pager). Deliberately keyed on strongly
// page/offset-named fields to avoid mistaking an ordinary numeric field for the pager.
const BODY_PAGE_KEY = /^(page|pagina|pag|pageno|pagenumber|p)$/i;
const BODY_OFFSET_KEY = /^(offset|start|from|skip)$/i;
function walkNumeric(node, cb, path = []) {
  if (!node || typeof node !== 'object') return;
  for (const k of Object.keys(node)) { const v = node[k]; cb(k, v, node); if (v && typeof v === 'object') walkNumeric(v, cb, path.concat(k)); }
}
function deduceBodyPaging(body, contentType) {
  if (!body) return null;
  let obj = null; try { obj = JSON.parse(body); } catch (e) {}
  if (obj && typeof obj === 'object') {
    let hit = null;
    walkNumeric(obj, (k, v, parent) => {
      if (hit || typeof v !== 'number' || !Number.isFinite(v)) return;
      if (BODY_PAGE_KEY.test(k)) hit = { key: k, kind: 'page', value: v, parent };
      else if (BODY_OFFSET_KEY.test(k)) hit = { key: k, kind: 'offset', value: v, parent };
    });
    if (!hit) return null;
    // A body offset (skip/start/from) is a real pager ONLY with a sibling POSITIVE page size; a
    // negative/absent size (e.g. GraphQL take:-1 = fetch everything at once) is NOT pagination.
    let step = 0;
    if (hit.kind === 'offset') {
      const sk = Object.keys(hit.parent).find((kk) => /^(take|limit|size|count|pagesize|rows|num)$/i.test(kk));
      step = sk ? Number(hit.parent[sk]) : NaN;
      if (!(Number.isFinite(step) && step > 0)) return null;
    }
    const SENT = '__HABEAS_PG__';
    hit.parent[hit.key] = SENT;
    const templated = JSON.stringify(obj).split('"' + SENT + '"').join('{' + hit.key + '}');
    hit.parent[hit.key] = hit.value; // restore (don't mutate the caller's parsed view)
    return hit.kind === 'page'
      ? { body: templated, paging: 'page', list: { pageParam: hit.key, pageStart: hit.value } }
      : { body: templated, paging: 'offset', list: { offsetParam: hit.key, offsetStart: 0, offsetStep: step } };
  }
  try {
    for (const [k, v] of new URLSearchParams(body)) {
      if (!/^\d+$/.test(v)) continue;
      const tmpl = () => body.replace(new RegExp('(^|&)(' + escRe(k) + ')=[^&]*'), (m, pre, key) => pre + key + '={' + key + '}');
      if (BODY_PAGE_KEY.test(k)) return { body: tmpl(), paging: 'page', list: { pageParam: k, pageStart: Number(v) } };
      if (BODY_OFFSET_KEY.test(k)) return { body: tmpl(), paging: 'offset', list: { offsetParam: k, offsetStart: 0 } };
    }
  } catch (e) {}
  return null;
}

// auth.context inference: a STABLE personal identifier (a DNI/NIF, a customer number) that the SPA
// puts in the URL of several requests — captured once as {ctx.<name>} and reused, instead of freezing
// one user's id into the source. Conservative: the value must (a) look like an id (alnum, ≥8, has a
// digit), (b) NOT be one of the list items' own field values (so a per-document id isn't mistaken for
// it), and (c) appear in the path of ANOTHER request (a separate capture source the runtime can read).
function inferAuthContext(listUrl, samples, items) {
  let lu; try { lu = new URL(listUrl); } catch (e) { return null; }
  const idLike = (v) => /^[0-9A-Za-z]{8,20}$/.test(v) && /\d/.test(v);
  const itemVals = new Set([...valueFields(items).keys()]);
  const segs = [...lu.pathname.split('/').filter(Boolean), ...lu.searchParams.values()];
  for (const v of segs) {
    if (!idLike(v) || itemVals.has(v)) continue;
    for (const s of samples || []) {
      let su; try { su = new URL(s.url); } catch (e) { continue; }
      if (su.host !== lu.host || su.pathname === lu.pathname) continue; // need a DIFFERENT request
      if (!su.pathname.split('/').filter(Boolean).includes(v)) continue;
      const match = escRe(su.pathname.slice(0, su.pathname.indexOf(v))) + '([0-9A-Za-z]+)';
      try { const m = new RegExp(match).exec(su.pathname); if (!m || m[1] !== v) continue; } catch (e) { continue; }
      return { name: /^\d{7,8}[A-Za-z]$/.test(v) ? 'dni' : 'accountId', match, value: v };
    }
  }
  return null;
}

// Build an adapter draft. `ctx` = { domain, pageHost, assets }. `chosen` (optional) = { key }
// picks a specific captured list; without it the biggest is used.
export function draftAdapterFromSamples(samples, ctx = {}, chosen = null) {
  const cand = [...collect(samples), ...collectHtml(samples)].sort((a, b) => b.len - a.len);
  if (!cand.length) return { ok: false, reason: 'no list-like response captured' };
  let best = cand[0];
  if (chosen) { const f = cand.find((c) => (chosen.key ? c.key === chosen.key : c.s.url === chosen.url && c.itemsPath === chosen.itemsPath)); if (f) best = f; }
  if (best.isHtml) return draftHtml(best, ctx);
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
      // from:'html' when the list came from the page's embedded SSR state (Vike/Next/…) rather than an
      // XHR — the runtime then fetches the page HTML and reads itemsPath out of its embedded JSON.
      list: Object.assign({ path: u.pathname, paging, itemsPath: best.itemsPath || 'items' }, best.fromHtml ? { from: 'html' } : {}, list),
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

  // POST/GraphQL list: the SPA sends the query/filter in the request BODY (Ikea's purchase-history
  // GraphQL; some REST APIs POST a JSON/form body). Reproduce it faithfully — method + body + the
  // content-type — so the runtime replays the SAME request (fetchList honours list.method/body, and
  // fillTmpl leaves a GraphQL body's own braces intact, only filling {token} placeholders).
  const method = (s.method || 'GET').toUpperCase();
  if (method !== 'GET' && s.reqBody) {
    draft.api.list.method = method;
    draft.api.list.body = s.reqBody;
    let ct = (reqHeaders['content-type'] || reqHeaders['Content-Type'] || '').split(';')[0].trim();
    if (!ct) { try { JSON.parse(s.reqBody); ct = 'application/json'; } catch (e) { ct = 'application/x-www-form-urlencoded'; } }
    draft.api.list.contentType = ct;
    // content-type is carried via list.contentType now → don't duplicate it in list.headers.
    if (draft.api.list.headers) { delete draft.api.list.headers['content-type']; if (!Object.keys(draft.api.list.headers).length) delete draft.api.list.headers; }
    // Pagination inside the body (page/offset field) — only if the URL didn't already yield a pager.
    // Runs before the CSRF step so it parses clean JSON (the CSRF step may inject a non-JSON {csrf}).
    if (draft.api.list.paging === 'none') {
      const bp = deduceBodyPaging(draft.api.list.body, ct);
      if (bp) { draft.api.list.body = bp.body; draft.api.list.paging = bp.paging; Object.assign(draft.api.list, bp.list); }
    }
    // A per-session CSRF token baked into the body → fetch it fresh via a prelude and template {csrf}.
    const csrf = inferCsrf(draft.api.list.body, samples);
    if (csrf) {
      draft.api.list.body = draft.api.list.body.split(csrf.tok).join('{csrf}');
      draft.api.csrf = { path: csrf.path, match: csrf.match };
      if (csrf.host && csrf.host !== host) draft.api.csrf.host = csrf.host;
    }
  }

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

  // A stable personal id the SPA puts in URLs → capture it as {ctx.*} and template the list/detail
  // path with it, so the source works for any user (not just the one whose id was captured).
  const actx = inferAuthContext(s.url, samples, best.items);
  if (actx) {
    draft.auth.context = [{ name: actx.name, from: 'url', match: actx.match }];
    const tok = '{ctx.' + actx.name + '}';
    draft.api.list.path = draft.api.list.path.split(actx.value).join(tok);
    if (draft.api.list.params) for (const k of Object.keys(draft.api.list.params)) draft.api.list.params[k] = String(draft.api.list.params[k]).split(actx.value).join(tok);
    if (draft.api.detail && draft.api.detail.path) draft.api.detail.path = draft.api.detail.path.split(actx.value).join(tok);
  }

  // The list array's field candidates power the visual mapper dropdowns.
  return { ok: true, draft, fieldCandidates: flat, itemsPath: best.itemsPath, host, count: best.len };
}

// A stream id from a list path's last segment (…/services/receipts → "receipts"), else stream<N>.
function streamIdFrom(path, i) {
  const seg = String(path || '').split('?')[0].split('/').filter(Boolean).pop() || '';
  const clean = seg.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return clean || 'stream' + (i + 1);
}

// Draft a MULTI-STREAM source: several distinct lists on the same registrable domain (Leroy Merlin's
// tickets + orders; WiZink's movimientos + extractos) become one source with a shared base
// (id/domain/auth/api.host) and a `streams[]`, each stream owning its api.list (+detail/pdf) + fields
// + schema. `chosenKeys` (from the picker) selects which candidate lists to include; without it, every
// candidate on the primary list's registrable domain is used. Degrades to a single-stream draft when
// fewer than two lists qualify. Each stream is drafted by the same single-list logic, so it inherits
// pagination/POST/CSRF/detail inference per stream.
export function draftStreamsFromSamples(samples, ctx = {}, chosenKeys = null) {
  const all = [...collect(samples), ...collectHtml(samples)].sort((a, b) => b.len - a.len);
  if (!all.length) return { ok: false, reason: 'no list-like response captured' };
  const regOf = (h) => String(h || '').split('.').slice(-2).join('.');
  const hostOfCand = (c) => { try { return new URL(c.s.url).host; } catch (e) { return ''; } };
  const dom = ctx.domain || regOf(hostOfCand(all[0]));

  let picks = (chosenKeys && chosenKeys.length)
    ? all.filter((c) => chosenKeys.includes(c.key))
    : all.filter((c) => regOf(hostOfCand(c)) === dom);
  const seen = new Set();
  picks = picks.filter((c) => (seen.has(c.key) ? false : seen.add(c.key))); // unique, biggest-first order
  if (picks.length < 2) return draftAdapterFromSamples(samples, ctx, picks[0] ? { key: picks[0].key } : null);

  const drafts = picks.map((c) => draftAdapterFromSamples(samples, ctx, { key: c.key })).filter((r) => r && r.ok);
  if (drafts.length < 2) return drafts[0] || { ok: false, reason: 'could not draft streams' };

  const base = drafts[0].draft;
  const used = new Set();
  const streams = drafts.map((r, i) => {
    const d = r.draft;
    let sid = streamIdFrom(d.api.list.path, i);
    while (used.has(sid)) sid += '-' + (i + 1);
    used.add(sid);
    const st = { id: sid, name: sid.charAt(0).toUpperCase() + sid.slice(1), schema: d.schema, categories: d.categories, api: { list: d.api.list }, fields: d.fields };
    if (d.api.detail) st.api.detail = d.api.detail;
    if (d.api.pdf) st.api.pdf = d.api.pdf;
    return st;
  });

  const draft = {
    id: base.id,
    name: (base.service ? base.service.charAt(0).toUpperCase() + base.service.slice(1) : base.id) + ' — documents',
    service: base.service,
    trust: 'community',
    domain: base.domain,
    categories: base.categories,
    match: base.match,
    auth: base.auth,
    api: { host: base.api.host },
    streams,
  };
  if (base.api.csrf) draft.api.csrf = base.api.csrf; // a shared prelude lives at the base
  return { ok: true, draft, streams, host: hostOfCand(all[0]), count: picks.reduce((n, c) => n + c.len, 0) };
}
