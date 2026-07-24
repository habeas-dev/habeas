// Adapter validation — pure, zero-dependency. Two jobs:
//   1. Structural validation: an adapter is DATA (no functions / no code), with the fields the
//      runtime needs. Mirrors adapters/schema/adapter.schema.json.
//   2. The security guard: every host an adapter touches (the site it matches, the API host it
//      replays the captured session to) must share ONE registrable domain (eTLD+1) — unless the
//      adapter declares an explicit `crossDomainHosts` allowlist, which is permitted but surfaced
//      to the user as an off-site-consent decision. This makes silent JWT exfiltration impossible.
import { outputsOf, resolveOutput } from '../lib/outputs.js';

// Compact public-suffix handling. Full PSL is huge; we bundle the common multi-label suffixes
// (ccSLDs) and default to "last two labels" otherwise. Conservative and good enough for the
// markets Habeas targets; the guard errs toward treating unknowns as their last two labels.
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk',
  'com.es', 'org.es', 'gob.es', 'edu.es', 'nom.es',
  'com.br', 'com.mx', 'com.ar', 'com.au', 'com.tr', 'com.cn', 'com.co', 'com.pe',
  'com.ve', 'com.py', 'com.uy', 'com.ec', 'com.pt', 'com.sg', 'com.hk',
  'co.jp', 'or.jp', 'ne.jp', 'co.kr', 'co.nz', 'co.in', 'co.za', 'co.il',
]);

export function hostOf(urlOrHost) {
  let h = String(urlOrHost || '').trim();
  h = h.replace(/^[a-z]+:\/\//i, '');       // strip scheme
  h = h.split('/')[0].split('?')[0];         // strip path/query
  h = h.split('@').pop();                     // strip userinfo
  h = h.split(':')[0];                        // strip port
  return h.toLowerCase().replace(/\.$/, '');
}

export function registrableDomain(urlOrHost) {
  const parts = hostOf(urlOrHost).split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

// Every host an adapter reads from / replays credentials to.
export function collectHosts(adapter) {
  const hosts = new Set();
  const api = adapter.api || {};
  if (api.host) hosts.add(hostOf(api.host));
  if (api.pdf && api.pdf.host) hosts.add(hostOf(api.pdf.host));       // the session is replayed here too
  if (api.detail && api.detail.host) hosts.add(hostOf(api.detail.host));
  if (api.document && api.document.host) hosts.add(hostOf(api.document.host));
  for (const m of adapter.match || []) hosts.add(hostOf(m));
  for (const h of adapter.captureHosts || []) hosts.add(hostOf(h));
  if (adapter.openUrl) hosts.add(hostOf(adapter.openUrl)); // the tab we open must stay within the source's domain
  return [...hosts].filter(Boolean);
}

// The core security check. Returns a structured result the loader/consent UI can use.
export function checkHosts(adapter) {
  const base = registrableDomain(adapter.domain || (adapter.api && adapter.api.host) || '');
  const extra = [...new Set((adapter.crossDomainHosts || []).map(registrableDomain))].filter(Boolean);
  // Brand domains: one source may operate on several TLDs of the SAME brand (amazon.es/.com/.de…). Each domain
  // uses its OWN browser-isolated cookie session — the source never replays one domain's session to another —
  // so these are allowed WITHOUT the off-site consent that crossDomainHosts needs. Cookie-mode only (enforced
  // in validateAdapter), because that's what makes the browser guarantee the per-domain session isolation.
  const brand = [...new Set((adapter.domains || []).map(registrableDomain))].filter(Boolean);
  const allowed = new Set([base, ...extra, ...brand].filter(Boolean));
  const hosts = collectHosts(adapter);
  const offenders = hosts.filter((h) => !allowed.has(registrableDomain(h)));
  return {
    ok: offenders.length === 0,
    base,
    allowed: [...allowed],
    crossDomain: extra,             // extra registrable domains → require explicit user consent
    brand,                          // same-brand TLDs → allowed without consent (cookie-isolated sessions)
    hosts,
    offenders,                      // hosts not covered by base / crossDomain / brand → hard reject
  };
}

// Deep "data only" guard: reject any function value anywhere in the object graph.
function hasNoCode(v, seen = new Set()) {
  if (typeof v === 'function') return false;
  if (v && typeof v === 'object') {
    if (seen.has(v)) return true;
    seen.add(v);
    for (const k of Object.keys(v)) if (!hasNoCode(v[k], seen)) return false;
  }
  return true;
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCHEMA_RE = /^[a-z_]+@\d+$/;
const PAGING = new Set(['offsets', 'offset', 'page', 'cursor', 'none', 'years']);

// Validate one extraction (a base source, or a resolved stream/format output): its list, schema, fields.
function checkExtraction(a, req, label) {
  const p = label ? `[${label}] ` : '';
  req(typeof a.schema === 'string' && SCHEMA_RE.test(a.schema), p + 'schema like "receipt@1" required');
  const list = (a.api && a.api.list) || {};
  const ws = a.api && a.api.ws;
  const mtop = a.api && a.api.mtop;
  if (mtop) {
    // Alibaba mtop-API source (AliExpress…): no HTTP list — declares the mtop api + a component-key extractor.
    req(typeof mtop.api === 'string' && mtop.api, p + 'api.mtop.api required');
    req(a.api.itemsFromKeys && typeof a.api.itemsFromKeys.prefix === 'string' && a.api.itemsFromKeys.prefix, p + 'api.itemsFromKeys.prefix required for an mtop source');
  } else if (ws) {
    // WebSocket-API source (Trade Republic): no HTTP list — declares a ws(s):// endpoint + a subscription.
    req(typeof ws.url === 'string' && /^wss?:\/\//.test(ws.url), p + 'api.ws.url must be a ws:// or wss:// URL');
    req(ws.sub && typeof ws.sub.type === 'string' && ws.sub.type, p + 'api.ws.sub.type required');
    req(typeof ws.itemsPath === 'string' && ws.itemsPath.length > 0, p + 'api.ws.itemsPath required');
  } else if (list.paging === 'synthetic') {
    // Synthetic list: documents aren't enumerated from an API list — they exist once per period/account
    // (a monthly or per-account statement). No path/itemsPath; the document itself comes from api.pdf.
    req(list.synthetic && ['months', 'group', 'group-months'].includes(list.synthetic.each), p + 'api.list.synthetic.each must be months|group|group-months');
  } else {
    // A list reads from a single `path`, OR from several `paths[]` merged (e.g. deposits from active + inactive).
    req((typeof list.path === 'string' && list.path.startsWith('/')) || (Array.isArray(list.paths) && list.paths.length > 0 && list.paths.every((x) => typeof x === 'string' && x.startsWith('/'))), p + 'api.list.path (or api.list.paths[]) required');
    req(list.from === 'html' || (typeof list.itemsPath === 'string' && list.itemsPath.length > 0) || (Array.isArray(list.itemsPath) && list.itemsPath.length > 0 && list.itemsPath.every((x) => typeof x === 'string' && x)), p + 'api.list.itemsPath required — a dotted path, or an array of candidate paths (unless list.from is "html")');
    req(!list.paging || PAGING.has(list.paging), p + 'api.list.paging must be offsets|offset|page|cursor|none|years');
  }
  const fields = a.fields || {};
  req(typeof fields.internalId === 'string', p + 'fields.internalId required');
  req(typeof fields.date === 'string', p + 'fields.date required');
}

// Canonical category catalog — the ONLY values a source may emit (used for sink compatibility).
// One source of truth; keep in sync with the schema enum and docs/categories.md. Extend here.
export const CATEGORIES = [
  // Retail purchases (receipts)
  'grocery', 'fuel', 'sports', 'fashion', 'electronics', 'home', 'diy', 'pharmacy',
  'restaurant', 'marketplace', 'travel', 'entertainment', 'retail',
  // Services (invoices)
  'energy', 'water', 'telecom', 'utility', 'tolls', 'transport', 'insurance',
  'subscription', 'domains', 'education', 'healthcare', 'government',
  // Financial (transactions / holdings)
  'card', 'cash', 'banking', 'investment', 'pension', 'crypto', 'loan',
  // Fallback
  'other',
];
const CATSET = new Set(CATEGORIES);
// Closest valid categories to a typo (e.g. "toll" → "tolls") — prefix/substring match, best few.
const nearestCats = (bad) => { const b = String(bad).toLowerCase(); return CATEGORIES.filter((c) => c.startsWith(b) || b.startsWith(c) || c.includes(b) || b.includes(c)).slice(0, 3); };
// A helpful "unknown category" message: each bad value with a suggestion, then the FULL allowed catalog inline
// (the author shouldn't have to open a doc to see the valid values).
function unknownCatMsg(label, bad) {
  const parts = bad.map((c) => { const s = nearestCats(c); return c + (s.length ? ` (did you mean: ${s.join(', ')}?)` : ''); });
  return `${label}: ${parts.join('; ')} — allowed categories: ${CATEGORIES.join(', ')}`;
}

export function validateAdapter(adapter) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

  req(adapter && typeof adapter === 'object' && !Array.isArray(adapter), 'adapter must be an object');
  if (!errors.length) {
    req(hasNoCode(adapter), 'adapter must be data only (no functions / code)');
    req(typeof adapter.id === 'string' && ID_RE.test(adapter.id), 'id: kebab-case required');
    req(typeof adapter.name === 'string' && adapter.name.length > 0, 'name required');
    req(typeof adapter.service === 'string' && adapter.service.length > 0, 'service required');
    req(Array.isArray(adapter.match) && adapter.match.length > 0, 'match[] required');
    req(Array.isArray(adapter.categories) && adapter.categories.length > 0, 'categories[] required');
    const badCats = (adapter.categories || []).filter((c) => !CATSET.has(c));
    req(!badCats.length, unknownCatMsg(`unknown categor${badCats.length > 1 ? 'ies' : 'y'}`, badCats));
    if (adapter.categorize) {
      const czVals = [adapter.categorize.default, ...Object.values(adapter.categorize.map || {})].filter((v) => v != null);
      const badCz = czVals.filter((c) => !CATSET.has(c));
      req(!badCz.length, unknownCatMsg(`categorize maps to unknown categor${badCz.length > 1 ? 'ies' : 'y'}`, badCz));
    }
    const api = adapter.api || {};
    // https everywhere; http only for loopback (local dev/testing sources — can't be MITM'd off-box).
    const okScheme = typeof api.host === 'string' && (/^https:\/\//.test(api.host) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(api.host));
    req(okScheme, 'api.host must be https (http allowed only for loopback)');
    // Extraction (list + schema + fields) is per OUTPUT when the source declares streams×formats — each
    // resolved output must be a valid extraction; otherwise the source itself is the single output.
    if (adapter.streams && adapter.streams.length) { for (const o of outputsOf(adapter)) checkExtraction(resolveOutput(adapter, o.id), req, o.id); }
    else checkExtraction(adapter, req);
    const auth = adapter.auth || {};
    req(Array.isArray(auth.replayHeaders), 'auth.replayHeaders must be an array (may be empty for cookie auth)');
    // tokenFromStorage: read the bearer FRESH from the page's localStorage each request (SPAs that keep + rotate
    // it there — WSO2/Akamai-fronted). Read in the site tab; guarded to the source's own origin like all else.
    if (auth.tokenFromStorage != null) req(auth.tokenFromStorage && typeof auth.tokenFromStorage.key === 'string' && auth.tokenFromStorage.key, 'auth.tokenFromStorage requires a localStorage key');
    // Optional anti-fingerprinting throttle between API calls.
    if (adapter.throttle != null) {
      const th = adapter.throttle;
      req(th && typeof th.minMs === 'number' && th.minMs >= 0 && (th.jitterMs == null || (typeof th.jitterMs === 'number' && th.jitterMs >= 0)),
        'throttle must be { minMs: number≥0, jitterMs?: number≥0 }');
    }

    // Multi-domain (brand) source: several TLDs of the same brand, one adapter. Cookie-only so the browser
    // isolates each domain's session (no cross-domain replay is even possible); the API host is resolved at
    // runtime to whichever brand domain the user's tab is on.
    if (Array.isArray(adapter.domains) && adapter.domains.length) {
      req(auth.mode === 'cookie', 'a multi-domain source (domains[]) must use auth.mode "cookie" — the browser then isolates each domain session, so one domain\'s session can never reach another');
      req(adapter.domains.every((d) => typeof d === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d)), 'domains[] must be registrable domains, e.g. "amazon.es"');
    }

    const h = checkHosts(adapter);
    req(h.ok, h.offenders.length
      ? `hosts outside the source domain (${h.base}): ${h.offenders.join(', ')} — add them to crossDomainHosts to allow with consent`
      : 'no host to derive the source domain from');
  }
  return { ok: errors.length === 0, errors };
}
