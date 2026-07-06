// Adapter validation — pure, zero-dependency. Two jobs:
//   1. Structural validation: an adapter is DATA (no functions / no code), with the fields the
//      runtime needs. Mirrors adapters/schema/adapter.schema.json.
//   2. The security guard: every host an adapter touches (the site it matches, the API host it
//      replays the captured session to) must share ONE registrable domain (eTLD+1) — unless the
//      adapter declares an explicit `crossDomainHosts` allowlist, which is permitted but surfaced
//      to the user as an off-site-consent decision. This makes silent JWT exfiltration impossible.

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
  for (const m of adapter.match || []) hosts.add(hostOf(m));
  for (const h of adapter.captureHosts || []) hosts.add(hostOf(h));
  return [...hosts].filter(Boolean);
}

// The core security check. Returns a structured result the loader/consent UI can use.
export function checkHosts(adapter) {
  const base = registrableDomain(adapter.domain || (adapter.api && adapter.api.host) || '');
  const extra = [...new Set((adapter.crossDomainHosts || []).map(registrableDomain))].filter(Boolean);
  const allowed = new Set([base, ...extra].filter(Boolean));
  const hosts = collectHosts(adapter);
  const offenders = hosts.filter((h) => !allowed.has(registrableDomain(h)));
  return {
    ok: offenders.length === 0,
    base,
    allowed: [...allowed],
    crossDomain: extra,             // extra registrable domains → require explicit user consent
    hosts,
    offenders,                      // hosts not covered by base or crossDomain → hard reject
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
const PAGING = new Set(['offsets', 'offset', 'page', 'cursor', 'none']);

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
    req(typeof adapter.schema === 'string' && SCHEMA_RE.test(adapter.schema), 'schema like "receipt@1" required');
    req(Array.isArray(adapter.categories) && adapter.categories.length > 0, 'categories[] required');
    const badCats = (adapter.categories || []).filter((c) => !CATSET.has(c));
    req(!badCats.length, `unknown categor${badCats.length > 1 ? 'ies' : 'y'}: ${badCats.join(', ')} — use the allowed catalog (see docs/categories.md)`);
    if (adapter.categorize) {
      const czVals = [adapter.categorize.default, ...Object.values(adapter.categorize.map || {})].filter((v) => v != null);
      const badCz = czVals.filter((c) => !CATSET.has(c));
      req(!badCz.length, `categorize maps to unknown categor${badCz.length > 1 ? 'ies' : 'y'}: ${badCz.join(', ')}`);
    }
    const api = adapter.api || {};
    // https everywhere; http only for loopback (local dev/testing sources — can't be MITM'd off-box).
    const okScheme = typeof api.host === 'string' && (/^https:\/\//.test(api.host) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(api.host));
    req(okScheme, 'api.host must be https (http allowed only for loopback)');
    const list = api.list || {};
    req(typeof list.path === 'string' && list.path.startsWith('/'), 'api.list.path required');
    req(list.from === 'html' || (typeof list.itemsPath === 'string' && list.itemsPath.length > 0), 'api.list.itemsPath required (unless list.from is "html")');
    req(!list.paging || PAGING.has(list.paging), 'api.list.paging must be offsets|page|cursor|none');
    const fields = adapter.fields || {};
    req(typeof fields.internalId === 'string', 'fields.internalId required');
    req(typeof fields.date === 'string', 'fields.date required');
    const auth = adapter.auth || {};
    req(Array.isArray(auth.replayHeaders), 'auth.replayHeaders must be an array (may be empty for cookie auth)');

    const h = checkHosts(adapter);
    req(h.ok, h.offenders.length
      ? `hosts outside the source domain (${h.base}): ${h.offenders.join(', ')} — add them to crossDomainHosts to allow with consent`
      : 'no host to derive the source domain from');
  }
  return { ok: errors.length === 0, errors };
}
