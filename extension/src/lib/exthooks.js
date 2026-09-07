// External-hooks protocol logic — pure and testable. A third-party site (ANY origin) may PROPOSE a
// workflow and, once the user approves it, REQUEST collection. Security rests on two rules enforced
// here, not on an allowlist:
//   1. Origin-bound sink — a site at origin X may only register/trigger a sink whose URL host === X.
//      This alone blocks exfiltration: a site can only route your data back to ITSELF.
//   2. Consent — every new scope needs the user's explicit Allow (handled by the consent page).
import { hostOf } from '../adapters/validate.js';

export const originHost = (origin) => hostOf(origin);

// Loopback hosts are trustworthy without TLS (mirrors the browsers' "potentially trustworthy
// origin" rule): the traffic never leaves the machine. Enables local development of consumers
// against http://localhost — origin-binding still applies, so only a page served ON localhost
// can propose a localhost sink.
function isLoopbackHost(h) {
  return h === 'localhost' || h.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(h);
}

// The sink URL must point back to the requesting origin's own host (nowhere else), over
// https — or plain http when the sink is loopback (local development).
export function sinkIsOriginBound(origin, sinkUrl) {
  const oh = originHost(origin);
  const sh = hostOf(sinkUrl || '');
  if (!oh || !sh || oh !== sh) return false;
  const url = String(sinkUrl || '');
  return /^https:\/\//i.test(url) || (/^http:\/\//i.test(url) && isLoopbackHost(sh));
}

// Validate a propose-workflow request. Returns { ok, error?, sink?, filter? }.
export function validateProposal(origin, msg) {
  if (!origin) return { ok: false, error: 'no origin' };
  const source = msg && msg.source;
  if (typeof source !== 'string' || !source) return { ok: false, error: 'missing source' };
  const sink = msg && msg.sink;
  if (!sink || sink.type !== 'http' || typeof sink.url !== 'string') return { ok: false, error: 'sink must be an http sink with a url' };
  if (!sinkIsOriginBound(origin, sink.url)) return { ok: false, error: 'origin-bound: the sink URL host must equal the requesting origin' };
  const filter = msg.filter && Array.isArray(msg.filter.categories) ? { categories: msg.filter.categories.map(String) } : undefined;
  const headers = sink.headers && typeof sink.headers === 'object' ? sink.headers : undefined;
  // A site MAY propose a friendly display name (untrusted → sanitized + length-capped; the origin id stays
  // visible next to it in Settings, so a spoofy name can't hide which site the destination really is).
  const name = typeof sink.name === 'string' ? sink.name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40) : '';
  return { ok: true, sink: { type: 'http', url: sink.url, ...(name ? { name } : {}), ...(headers ? { headers } : {}) }, filter };
}

// Validate a register-sink request — a site registering itself as a DESTINATION with no source and no
// grant (the user routes sources to it later, from Settings). Same origin-binding + name sanitization as
// a proposal, minus the source/filter. Returns { ok, error?, sink? }.
export function validateSink(origin, msg) {
  if (!origin) return { ok: false, error: 'no origin' };
  const sink = msg && msg.sink;
  if (!sink || sink.type !== 'http' || typeof sink.url !== 'string') return { ok: false, error: 'sink must be an http sink with a url' };
  if (!sinkIsOriginBound(origin, sink.url)) return { ok: false, error: 'origin-bound: the sink URL host must equal the requesting origin' };
  const headers = sink.headers && typeof sink.headers === 'object' ? sink.headers : undefined;
  const name = typeof sink.name === 'string' ? sink.name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40) : '';
  return { ok: true, sink: { type: 'http', url: sink.url, ...(name ? { name } : {}), ...(headers ? { headers } : {}) } };
}

// A short, stable id for a sink derived from its origin host (so re-proposals reuse the same sink).
export function sinkIdForOrigin(origin) {
  return 'ext-' + originHost(origin).replace(/[^a-z0-9]/gi, '-');
}

// PUBLIC metadata of the user's currently-enabled sources — the payload of the `list-sources` hook. Only
// non-sensitive descriptive fields (id, name, service, categories, trust label); never accounts, routes,
// sinks, credentials or the user's data. Pure so it's trivially testable.
export function enabledSources(cfg, adapters) {
  const out = [];
  for (const d of ((cfg && cfg.datasources) || [])) {
    if (!d || !d.enabled) continue;
    const a = adapters && adapters[d.adapter];
    if (!a) continue;
    out.push({
      source: a.id,
      name: a.name || a.id,
      service: a.service || a.id,
      categories: Array.isArray(a.categories) ? a.categories.slice() : [],
      trust: a.trust || 'community',
    });
  }
  return out;
}

// ── query hook (read vein) — pure helpers, kept here so they can be unit-tested apart from the
// background's storage/message plumbing. See docs/external-hooks.md and background.js#queryForGrant. ──

// Trim a consumer's query to a known, bounded shape before it ever touches the store. The requesting
// page controls these strings, so cap their length and drop anything unexpected.
export function sanitizeQuery(q) {
  q = (q && typeof q === 'object') ? q : {};
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const numOr = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  return {
    schema: str(q.schema, 20),
    source: str(q.source, 80),
    text: str(q.text, 200),
    dateFrom: str(q.dateFrom, 32),
    dateTo: str(q.dateTo, 32),
    amount: numOr(q.amount),
    amountTolerance: numOr(q.amountTolerance),
    currency: str(q.currency, 8),
  };
}

// Does one canonical-store record match a (sanitized) query? Pure predicate.
//  · date range on the booked date (YYYY-MM-DD string compare)
//  · amount on ABSOLUTE value ±tolerance, so a consumer's signed charge (-47.85) matches a receipt's
//    positive total; default tolerance 0.02 absorbs rounding
//  · free text against counterparty + description + number (case-insensitive substring)
// `counterparty` is passed in (the caller resolves it via canonicalize) to keep this dependency-free.
export function queryAccepts(record, query, counterparty = '') {
  if (!record) return false;
  const q = query || {};
  const date = String(record.date || '').slice(0, 10);
  if (q.dateFrom && date < q.dateFrom) return false;
  if (q.dateTo && date > q.dateTo) return false;
  if (typeof q.amount === 'number') {
    const raw = record.total != null ? record.total : record.amount;
    const a = Number(raw);
    if (!isFinite(a)) return false;
    const tol = typeof q.amountTolerance === 'number' ? Math.abs(q.amountTolerance) : 0.02;
    if (Math.abs(Math.abs(a) - Math.abs(q.amount)) > tol) return false;
  }
  if (q.text) {
    const hay = ((counterparty || '') + ' ' + (record.description || '') + ' ' + (record.number || '')).toLowerCase();
    if (!hay.includes(String(q.text).toLowerCase())) return false;
  }
  return true;
}
