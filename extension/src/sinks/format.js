// Shared formatting helpers used by every sink.
import { renderPath } from '../lib/naming.js';

export function pathFor(sink, d, opts, ext) {
  ext = ext || (opts && opts.ext) || 'pdf';
  const group = groupDir(d); // grouped source (bank account/card) → a subfolder under the service
  const tpl = sink.pathTemplate || ('{service}/' + (group ? '{group}/' : '') + '{yyyy}/{date}-{internalId}.{ext}');
  return renderPath(tpl, {
    service: (opts && opts.service) || 'documents',
    date: (d.date || '').slice(0, 10),
    internalId: d.internalId, ext, group,
  });
}
// A friendly, filesystem-safe folder name for the doc's group: product name + last 4 (e.g. "WiZink Oro 8765").
function groupDir(d) {
  const g = d && d._group;
  if (!g) return '';
  const last4 = String(g.mask || g.iban || g.id || '').match(/(\d{4})\s*$/);
  return [g.name || g.alias, last4 ? last4[1] : ''].filter(Boolean).join(' ').trim() || String(g.id || '').slice(-8);
}
// A mapped doc already carries its normalized record (built at inventory time, where the
// adapter is known). toRecord returns it; the legacy fallback keeps receipt shape for callers
// that pass a bare doc.
export function toRecord(d) {
  return d.record || buildRecord(d, null);
}

// Schema-aware normalized record. `receipt@1` is byte-identical to the historical shape so
// existing manifests do not change. New schemas (invoice/transaction/investment) shape the
// same mapped doc differently. Currency defaults to EUR unless the adapter overrides it.
export function buildRecord(d, adapter) {
  const schema = (adapter && adapter.schema) || 'receipt@1';
  const kind = String(schema).split('@')[0];
  const currency = (adapter && adapter.currency) || 'EUR';
  // `number` = the public receipt/invoice number the user sees (distinct from the internal
  // internalId). Added only when mapped, so receipt@1 stays byte-identical when absent.
  const withNumber = (r) => (d.number != null ? { ...r, number: d.number } : r);
  if (kind === 'transaction') {
    const r = { internalId: d.internalId, date: d.date, amount: num(d.amount ?? d.total), currency, category: d.category, description: d.description ?? d.label ?? '', counterparty: d.counterparty ?? d.party ?? '', direction: d.direction ?? dirOf(d.amount ?? d.total), source: d.source, type: d.type };
    // Carry any extra per-movement data a card source captures (merchant city, card mask…) so nothing is lost.
    if (d.location != null && d.location !== '') r.location = d.location;
    if (d.card != null && d.card !== '') r.card = d.card;
    return withNumber(r);
  }
  if (kind === 'investment') {
    return withNumber({ internalId: d.internalId, date: d.date, instrument: d.instrument ?? d.label ?? '', isin: d.isin ?? '', units: num(d.units), price: num(d.price), amount: num(d.amount ?? d.total), currency, category: d.category, operation: d.operation ?? d.type, source: d.source });
  }
  if (kind === 'invoice') {
    return { internalId: d.internalId, date: d.date, total: num(d.total), currency, category: d.category, issuer: { name: d.issuer ?? d.storeName ?? d.party ?? '', address: d.issuerAddress ?? d.storeAddress ?? '' }, number: d.number ?? d.internalId, source: d.source, type: d.type };
  }
  // receipt@1 (default) — unchanged shape (number appended only when present).
  return withNumber({ internalId: d.internalId, date: d.date, total: d.total, currency, category: d.category, store: { name: d.storeName, address: d.storeAddress }, source: d.source, type: d.type });
}
function num(v) { if (v == null || v === '') return v; const n = Number(v); return Number.isFinite(n) ? n : v; }
function dirOf(v) { const n = Number(v); return Number.isFinite(n) ? (n < 0 ? 'debit' : 'credit') : undefined; }

// Source-level compatibility: does this sink accept documents from this source at all?
// A sink with no `accepts` takes everything (download/local/drive). A sink may restrict by
// category and/or an explicit source-id allowlist.
export function sinkAcceptsSource(sink, adapter) {
  const a = sink && sink.accepts;
  if (!a || (!(a.categories && a.categories.length) && !(a.sources && a.sources.length))) return true;
  if (a.sources && a.sources.includes(adapter.id)) return true;
  const cats = adapter.categories || [];
  return !!(a.categories && a.categories.some((c) => cats.includes(c)));
}
// Artifact filter: which artifact kinds ('data' | 'document') this sink takes. No `accepts.artifacts`
// → all (generic file sinks store both the JSON and the presentable HTML/PDF).
export function sinkAcceptsArtifact(sink, artifact) {
  // Accepts the full artifact {kind, ext} (preferred) or a bare kind string (back-compat).
  const kind = artifact && typeof artifact === 'object' ? artifact.kind : artifact;
  const ext = artifact && typeof artifact === 'object' ? artifact.ext : undefined;
  const acc = (sink && sink.accepts) || {};
  if (acc.artifacts && acc.artifacts.length && !acc.artifacts.includes(kind)) return false;
  // accepts.formats: file formats the sink takes (e.g. ['pdf'] or ['xls','csv']). Absent → any.
  if (acc.formats && acc.formats.length && ext != null && !acc.formats.includes(ext)) return false;
  return true;
}
// The distinct file formats a source produces (json | pdf | xls | html | …), from its artifact kinds.
export function sourceFormats(artifactKinds) {
  return [...new Set((artifactKinds || []).map((k) => k.ext).filter(Boolean))];
}
// Document-level filter: only send docs whose category the sink accepts.
export function acceptsDoc(sink, doc) {
  const a = sink && sink.accepts;
  if (!a || !(a.categories && a.categories.length)) return true;
  return a.categories.includes(doc.category);
}
export function toRecords(docs, files) {
  return docs.map((d) => ({ ...toRecord(d), pdf: files.has(d.internalId) }));
}
// Merge new records into an existing manifest array by internalId (new wins), newest first.
export function mergeRecords(existing, incoming) {
  const map = new Map();
  for (const r of existing || []) if (r && r.internalId) map.set(r.internalId, r);
  for (const r of incoming) map.set(r.internalId, r);
  return [...map.values()].sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
}
export function buildManifest(docs, files) {
  return JSON.stringify(toRecords(docs, files), null, 2);
}
export function jsonBlob(s) { return new Blob([s], { type: 'application/json' }); }
export function today() { return new Date().toISOString().slice(0, 10); }
