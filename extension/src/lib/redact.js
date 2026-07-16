// PII redaction for record-mode HANDOFF. Lets a helper share a recording with a maintainer WITHOUT
// leaking personal data: we keep the STRUCTURE a maintainer needs to author a source (endpoint paths,
// field NAMES, response SHAPES, pagination params, transport) and replace every VALUE with a
// type-classified placeholder ([date], [amount:EUR], [id], [text], …). Auth/tokens and page text are
// never included in a handoff at all. Pure + dependency-free so it's unit-tested — this is security
// code: a leak here is the whole risk, so redaction is deliberately aggressive (privacy > convenience).

const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i;
const DATE = /^(\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-zÁÉÍÓÚáéíóúñ]{3,}\.?,?\s+\d{4})$/;
const CURRENCY = /€|eur|usd|\$|£|gbp|mxn|brl|cny/i;
const PHONE = /^\+?[\d][\d\s().-]{7,}\d$/;
const curOf = (s) => { const m = /(€|eur|usd|\$|£|gbp|mxn|brl|cny)/i.exec(s); return m ? m[1].toUpperCase().replace('€', 'EUR').replace('$', 'USD').replace('£', 'GBP') : 'CUR'; };
function luhn(n) { let sum = 0, alt = false; for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; } return sum % 10 === 0; }

// Correlation-preserving tags. Structural identifiers (opaque tokens, long numeric ids) redact to a
// STABLE [id#N] per distinct real value — so a maintainer can trace that a path segment, a header, and a
// response field all hold the SAME id, WITHOUT ever seeing the value (answers most "where does this come
// from?" questions structurally). Personal values (names, IBANs, cards, emails, phones) are NEVER
// correlated. Bundle-scoped; created once per handoff. Pass one through to enable correlation; omit for
// standalone redaction (generic placeholders).
export function makeRefs() {
  const map = new Map(); let n = 0;
  return (val) => { const k = String(val); if (!map.has(k)) map.set(k, ++n); return '[id#' + map.get(k) + ']'; };
}

// A single leaf string → a type-classified placeholder that reveals the KIND (so a maintainer can
// classify the field) but never the content. With `refs`, id-like values get a correlatable [id#N] tag.
// Order matters: most-specific first.
export function redactString(s, key = '', refs = null) {
  s = String(s == null ? '' : s);
  if (!s) return s;
  if (JWT.test(s)) return '[jwt]';
  if (EMAIL.test(s)) return '[email]';
  if (/^(https?|wss?):\/\//i.test(s)) return redactUrl(s, refs);
  const nosp = s.replace(/[\s-]/g, '');
  if (IBAN.test(nosp)) return '[iban]';
  if (/^\d{13,19}$/.test(nosp) && luhn(nosp)) return '[card]';
  if (DATE.test(s)) return '[date]';
  if (CURRENCY.test(s) && /\d/.test(s)) return '[amount:' + curOf(s) + ']';
  if (/^\d{1,4}$/.test(s)) return s;                                             // short numeric → a system/product code (centerCode…), not a client id — kept
  if (/^\d{5,}$/.test(s)) return refs ? refs(s) : '[num:' + s.length + ']';      // longer numeric id (postcode/account/…) → redacted/correlatable
  if (/^[A-Za-z0-9_.:+/=-]{20,}$/.test(s)) return refs ? refs(s) : '[token]';    // long opaque id/token → correlatable
  if (PHONE.test(s) && /[\s+().-]/.test(s) && (s.match(/\d/g) || []).length >= 8) return '[phone]'; // formatted phone (has separators)
  return '[text]';                                                     // any other free text (names, addresses…)
}

// A query-param VALUE. Unlike JSON leaves (always redacted), query params are mostly non-PII filters an
// author NEEDS (paginationType=CLOSE, monthFilter=202506, from=2026-06-01), so keep short single-token
// enums/codes/dates/flags — but still redact anything PII-shaped, a long numeric id/account, a long
// opaque token, or a multi-word value (a name/address could hide there).
export function redactParam(v, refs = null) {
  const s = String(v == null ? '' : v);
  if (!s) return s;
  const c = redactString(s, '', refs);
  if (c === '[email]' || c === '[jwt]' || c === '[iban]' || c === '[card]' || c === '[phone]') return '[v]';
  if (typeof c === 'string' && c.indexOf('[id#') === 0) return c;         // correlatable id/token → keep the tag
  if (c === '[token]') return refs ? refs(s) : '[v]';                     // (no-refs fallback)
  if (/^\d{7,}$/.test(s)) return refs ? refs(s) : '[v]';                  // long numeric id / account number → correlatable
  if (s.length > 24 || /\s/.test(s) || !/^[\w.:=+/-]+$/.test(s)) return '[v]'; // multi-word / long / odd → could be a name/address
  return s;                                                                // short single-token enum/code/date/flag — kept
}

// Keep the endpoint SHAPE (scheme+host+path template, param names) but redact id-like path segments and
// PII/id query VALUES (enum values kept — see redactParam). e.g.
// /tickets/3073…/pdf?type=CLOSE&token=abc… → /tickets/[id]/pdf?type=CLOSE&token=[v]
export function redactUrl(u, refs = null) {
  try {
    const url = new URL(u);
    // Redact id-like runs WITHIN each segment (a long digit run, or a 20+ opaque token) — catches
    // /tickets/3073…, /inv/3073….pdf (digits + extension), /doc/aZ9…hash/ alike; keeps stable path words.
    const idRun = (m) => (refs ? refs(m) : '[id]');
    const path = url.pathname.split('/').map((seg) => seg.replace(/[A-Za-z0-9_-]{20,}/g, idRun).replace(/\d{5,}/g, idRun)).join('/');
    const names = [...new Set([...url.searchParams.keys()])];
    const q = names.length ? '?' + names.map((k) => k + '=' + redactParam(url.searchParams.get(k), refs)).join('&') : '';
    return url.protocol + '//' + url.host + path + q;
  } catch (e) { return '[url]'; }
}

// A component/DIDA key that embeds an id (pc_om_list_order_3073…) → keep the prefix, redact/tag the id.
function redactKey(k, refs = null) { return String(k).replace(/^(.+_)(\d{4,}|[A-Za-z0-9]{12,})$/, (m, p, id) => p + (refs ? refs(id) : '[id]')); }

// Deep-redact a JSON value: keep keys + structure, redact every leaf. Arrays are capped (shape, not bulk).
export function redactJson(v, key = '', depth = 0, refs = null) {
  if (v == null || typeof v === 'boolean') return v;                        // booleans are flags, not PII
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1000 ? v : 0; // small ints (counts/pages) kept
  if (typeof v === 'string') return redactString(v, key, refs);
  if (Array.isArray(v)) { const a = v.slice(0, 3).map((x) => redactJson(x, key, depth + 1, refs)); if (v.length > 3) a.push('[+' + (v.length - 3) + ' more]'); return a; }
  if (typeof v === 'object' && depth < 14) { const o = {}; for (const k of Object.keys(v)) o[redactKey(k, refs)] = redactJson(v[k], k, depth + 1, refs); return o; }
  return '[?]';
}

// Regex backstop for free text we can't structurally parse (a WS frame's non-JSON parts).
export function scrubText(s) {
  return String(s == null ? '' : s)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
    .replace(/[A-Z]{2}\d{2}[A-Z0-9]{10,30}/g, '[iban]')
    .replace(/[^\s@"']+@[^\s@"']+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d{13,19}\b/g, '[num]');
}

// A WebSocket/SSE frame: redact any embedded JSON object, scrub the surrounding framing.
export function redactFrame(frame, refs = null) {
  if (typeof frame !== 'string') return frame;
  const i = frame.indexOf('{'), j = frame.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return scrubText(frame.slice(0, i)) + JSON.stringify(redactJson(JSON.parse(frame.slice(i, j + 1)), '', 0, refs)) + scrubText(frame.slice(j + 1)); } catch (e) {} }
  return scrubText(frame);
}

// A request body: form-encoded (a=b&data=<json>) or JSON or free text.
export function redactBody(body, refs = null) {
  if (typeof body !== 'string' || !body) return body;
  try { return JSON.stringify(redactJson(JSON.parse(body), '', 0, refs)); } catch (e) {}
  if (/^[^=&\s]+=/.test(body)) {
    try {
      const out = [];
      for (const [k, val] of new URLSearchParams(body)) { let rv; try { rv = JSON.stringify(redactJson(JSON.parse(val), '', 0, refs)); } catch (e) { rv = redactString(val, k, refs); } out.push(k + '=' + rv); }
      return out.join('&');
    } catch (e) {}
  }
  return scrubText(body);
}

// Request headers: keep the NAMES (shape), drop auth/token values entirely, redact the rest; a few
// config headers (content-type, accept) are safe to keep verbatim (they help authoring, no PII).
const DROP_HDR = /token|csrf|xsrf|auth|cookie|sessionid|api-key|requestorigin/i;
const KEEP_HDR = /^(content-type|accept|accept-language)$/i;
export function redactHeaders(h, refs = null) {
  const out = {};
  for (const k of Object.keys(h || {})) out[k] = DROP_HDR.test(k) ? '[redacted]' : (KEEP_HDR.test(k) ? h[k] : redactString(String(h[k]), k, refs));
  return out;
}

// Keep the table SHAPE (tags + class attributes, which drive HTML field inference) but blank every text
// node and drop all other attributes (href/id/data-* can carry ids). scrubText backstop on the whole.
export function redactHtml(html) {
  const structural = String(html == null ? '' : html)
    .replace(/<([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\s*(\/?)>/g, (m, tag, attrs, close) => { const cls = /\bclass\s*=\s*("[^"]*"|'[^']*')/i.exec(attrs || ''); return '<' + tag + (cls ? ' class=' + cls[1] : '') + close + '>'; })
    .replace(/>([^<]+)</g, (m, txt) => (txt.trim() ? '>[text]<' : m));
  return scrubText(structural);
}

// Redact one captured sample (HTTP request/response, or a WS frame carried as a sample). Pass a shared
// `refs` so id values correlate across the whole bundle (path ↔ header ↔ field).
export function redactSample(s, refs = null) {
  const out = { url: s.url ? redactUrl(s.url, refs) : s.url, method: s.method, status: s.status };
  if (s.kind) out.kind = s.kind;
  if (s.event) out.event = s.event;
  if (s.reqHeaders) out.reqHeaders = redactHeaders(s.reqHeaders, refs);
  if (s.reqBody) out.reqBody = redactBody(s.reqBody, refs);
  if (s.json !== undefined) out.json = redactJson(s.json, '', 0, refs);
  if (s.html !== undefined) out.html = redactHtml(s.html);
  if (s.frame !== undefined) out.frame = redactFrame(s.frame, refs);
  return out;
}

// SPAs often derive a path/query id from a CLAIM inside the session JWT (not from any response), which
// makes that id untraceable in a handoff. So we include the JWT's decoded PAYLOAD claims — claim NAMES +
// value-redacted (correlated) — so a maintainer can see e.g. the movements path [id#9] == claim
// `entityId: [id#9]`. NEVER the raw token, header, or signature; claim values are redacted like any JSON
// (ids → [id#N], name/email → [text]/[email]).
function b64urlToJson(seg) {
  let s = String(seg).replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  return JSON.parse(atob(s));
}
// Collect the decoded, redacted PAYLOAD claims of EVERY JWT in the recording — auth headers AND response
// bodies (an SPA often reads an entity/user id out of a JWT the login endpoint RETURNS, and uses it in a
// later path/query; the bearer header itself may be an opaque token). Claim NAMES + value-redacted
// (correlated), so a token-derived id traces to its claim. Never the raw token/signature. Deduped, capped.
const JWT_ANY = /eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]*/g;
function collectJwtClaims(samples, refs) {
  const payloads = new Set();
  const scan = (v, depth = 0) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') { let m; JWT_ANY.lastIndex = 0; while ((m = JWT_ANY.exec(v))) payloads.add(m[1]); }
    else if (Array.isArray(v)) v.slice(0, 3).forEach((x) => scan(x, depth + 1));
    else if (typeof v === 'object') Object.values(v).forEach((x) => scan(x, depth + 1));
  };
  for (const s of samples || []) { scan(s && s.reqHeaders); scan(s && s.json); scan(s && s.reqBody); }
  const out = [];
  for (const p of [...payloads].slice(0, 8)) { try { const c = b64urlToJson(p); if (c && typeof c === 'object') out.push(redactJson(c, '', 0, refs)); } catch (e) {} }
  return out;
}

// Build the shareable handoff bundle. DELIBERATELY excludes auth (live tokens) and dom page text (full
// of PII, low authoring value). Everything included is value-redacted, and id values are correlated with a
// bundle-scoped `refs` tagger: the SAME real id → the same [id#N] everywhere (path, header, field), so a
// maintainer can trace provenance without any technical questions and without seeing a single value.
export function buildHandoff({ domain, samples, wsframes, assets }) {
  const refs = makeRefs();
  const out = {
    habeasHandoff: 1,
    kind: 'redacted-recording',
    domain: domain || '',
    note: 'Redacted recording for source authoring. Field names + structure kept; personal VALUES removed; no auth/tokens/page-text included. Repeated id VALUES share a stable [id#N] tag so provenance is traceable without revealing the value.',
    counts: { samples: (samples || []).length, wsframes: (wsframes || []).length, assets: (assets || []).length },
    samples: (samples || []).map((s) => redactSample(s, refs)),
    wsframes: (wsframes || []).map((f) => ({ event: f.event, url: f.url ? redactUrl(f.url, refs) : f.url, frame: f.frame != null ? redactFrame(f.frame, refs) : f.frame })),
    assets: (assets || []).map((a) => ({ method: a.method, url: a.url ? redactUrl(a.url, refs) : a.url, reqType: a.reqType })),
  };
  const claims = collectJwtClaims(samples, refs); // redacted claims of every JWT (header + response body) — traces JWT-derived path/query ids
  if (claims.length) out.tokenClaims = claims;
  return out;
}
