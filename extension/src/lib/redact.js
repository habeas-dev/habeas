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

// A single leaf string → a type-classified placeholder that reveals the KIND (so a maintainer can
// classify the field) but never the content. Order matters: most-specific first.
export function redactString(s, key = '') {
  s = String(s == null ? '' : s);
  if (!s) return s;
  if (JWT.test(s)) return '[jwt]';
  if (EMAIL.test(s)) return '[email]';
  if (/^(https?|wss?):\/\//i.test(s)) return redactUrl(s);
  const nosp = s.replace(/[\s-]/g, '');
  if (IBAN.test(nosp)) return '[iban]';
  if (/^\d{13,19}$/.test(nosp) && luhn(nosp)) return '[card]';
  if (DATE.test(s)) return '[date]';
  if (CURRENCY.test(s) && /\d/.test(s)) return '[amount:' + curOf(s) + ']';
  if (/^\d{4,}$/.test(s)) return '[num:' + s.length + ']';            // pure numeric id (before phone: a long digit run isn't a phone)
  if (/^[A-Za-z0-9_.:+/=-]{20,}$/.test(s)) return '[token]';          // long opaque id/token
  if (PHONE.test(s) && /[\s+().-]/.test(s) && (s.match(/\d/g) || []).length >= 8) return '[phone]'; // formatted phone (has separators)
  return '[text]';                                                     // any other free text (names, addresses…)
}

// A query-param VALUE. Unlike JSON leaves (always redacted), query params are mostly non-PII filters an
// author NEEDS (paginationType=CLOSE, monthFilter=202506, from=2026-06-01), so keep short single-token
// enums/codes/dates/flags — but still redact anything PII-shaped, a long numeric id/account, a long
// opaque token, or a multi-word value (a name/address could hide there).
export function redactParam(v) {
  const s = String(v == null ? '' : v);
  if (!s) return s;
  const c = redactString(s);
  if (c === '[email]' || c === '[jwt]' || c === '[iban]' || c === '[card]' || c === '[phone]' || c === '[token]') return '[v]';
  if (/^\d{7,}$/.test(s)) return '[v]';                                   // long numeric id / account number
  if (s.length > 24 || /\s/.test(s) || !/^[\w.:=+/-]+$/.test(s)) return '[v]'; // multi-word / long / odd → could be a name/address
  return s;                                                                // short single-token enum/code/date/flag — kept
}

// Keep the endpoint SHAPE (scheme+host+path template, param names) but redact id-like path segments and
// PII/id query VALUES (enum values kept — see redactParam). e.g.
// /tickets/3073…/pdf?type=CLOSE&token=abc… → /tickets/[id]/pdf?type=CLOSE&token=[v]
export function redactUrl(u) {
  try {
    const url = new URL(u);
    // Redact id-like runs WITHIN each segment (a long digit run, or a 20+ opaque token) — catches
    // /tickets/3073…, /inv/3073….pdf (digits + extension), /doc/aZ9…hash/ alike; keeps stable path words.
    const path = url.pathname.split('/').map((seg) => seg.replace(/[A-Za-z0-9_-]{20,}/g, '[id]').replace(/\d{5,}/g, '[id]')).join('/');
    const names = [...new Set([...url.searchParams.keys()])];
    const q = names.length ? '?' + names.map((k) => k + '=' + redactParam(url.searchParams.get(k))).join('&') : '';
    return url.protocol + '//' + url.host + path + q;
  } catch (e) { return '[url]'; }
}

// A component/DIDA key that embeds an id (pc_om_list_order_3073…) → keep the prefix, redact the id.
function redactKey(k) { return String(k).replace(/^(.+_)(\d{4,}|[A-Za-z0-9]{12,})$/, '$1[id]'); }

// Deep-redact a JSON value: keep keys + structure, redact every leaf. Arrays are capped (shape, not bulk).
export function redactJson(v, key = '', depth = 0) {
  if (v == null || typeof v === 'boolean') return v;                        // booleans are flags, not PII
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1000 ? v : 0; // small ints (counts/pages) kept
  if (typeof v === 'string') return redactString(v, key);
  if (Array.isArray(v)) { const a = v.slice(0, 3).map((x) => redactJson(x, key, depth + 1)); if (v.length > 3) a.push('[+' + (v.length - 3) + ' more]'); return a; }
  if (typeof v === 'object' && depth < 14) { const o = {}; for (const k of Object.keys(v)) o[redactKey(k)] = redactJson(v[k], k, depth + 1); return o; }
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
export function redactFrame(frame) {
  if (typeof frame !== 'string') return frame;
  const i = frame.indexOf('{'), j = frame.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return scrubText(frame.slice(0, i)) + JSON.stringify(redactJson(JSON.parse(frame.slice(i, j + 1)))) + scrubText(frame.slice(j + 1)); } catch (e) {} }
  return scrubText(frame);
}

// A request body: form-encoded (a=b&data=<json>) or JSON or free text.
export function redactBody(body) {
  if (typeof body !== 'string' || !body) return body;
  try { return JSON.stringify(redactJson(JSON.parse(body))); } catch (e) {}
  if (/^[^=&\s]+=/.test(body)) {
    try {
      const out = [];
      for (const [k, val] of new URLSearchParams(body)) { let rv; try { rv = JSON.stringify(redactJson(JSON.parse(val))); } catch (e) { rv = redactString(val, k); } out.push(k + '=' + rv); }
      return out.join('&');
    } catch (e) {}
  }
  return scrubText(body);
}

// Request headers: keep the NAMES (shape), drop auth/token values entirely, redact the rest; a few
// config headers (content-type, accept) are safe to keep verbatim (they help authoring, no PII).
const DROP_HDR = /token|csrf|xsrf|auth|cookie|sessionid|api-key|requestorigin/i;
const KEEP_HDR = /^(content-type|accept|accept-language)$/i;
export function redactHeaders(h) {
  const out = {};
  for (const k of Object.keys(h || {})) out[k] = DROP_HDR.test(k) ? '[redacted]' : (KEEP_HDR.test(k) ? h[k] : redactString(String(h[k]), k));
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

// Redact one captured sample (HTTP request/response, or a WS frame carried as a sample).
export function redactSample(s) {
  const out = { url: s.url ? redactUrl(s.url) : s.url, method: s.method, status: s.status };
  if (s.kind) out.kind = s.kind;
  if (s.event) out.event = s.event;
  if (s.reqHeaders) out.reqHeaders = redactHeaders(s.reqHeaders);
  if (s.reqBody) out.reqBody = redactBody(s.reqBody);
  if (s.json !== undefined) out.json = redactJson(s.json);
  if (s.html !== undefined) out.html = redactHtml(s.html);
  if (s.frame !== undefined) out.frame = redactFrame(s.frame);
  return out;
}

// Build the shareable handoff bundle. DELIBERATELY excludes auth (live tokens) and dom page text (full
// of PII, low authoring value). Everything included is value-redacted.
export function buildHandoff({ domain, samples, wsframes, assets }) {
  return {
    habeasHandoff: 1,
    kind: 'redacted-recording',
    domain: domain || '',
    note: 'Redacted recording for source authoring. Field names + structure kept; personal VALUES removed; no auth/tokens/page-text included.',
    counts: { samples: (samples || []).length, wsframes: (wsframes || []).length, assets: (assets || []).length },
    samples: (samples || []).map(redactSample),
    wsframes: (wsframes || []).map((f) => ({ event: f.event, url: f.url ? redactUrl(f.url) : f.url, frame: f.frame != null ? redactFrame(f.frame) : f.frame })),
    assets: (assets || []).map((a) => ({ method: a.method, url: a.url ? redactUrl(a.url) : a.url, reqType: a.reqType })),
  };
}
