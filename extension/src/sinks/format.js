// Shared formatting helpers used by every sink.
import { renderPath } from '../lib/naming.js';

export function pathFor(sink, d, opts) {
  const ext = (opts && opts.ext) || 'pdf';
  const tpl = sink.pathTemplate || '{service}/{yyyy}/{date}-{externalId}.{ext}';
  return renderPath(tpl, {
    service: (opts && opts.service) || 'documents',
    date: (d.date || '').slice(0, 10),
    externalId: d.externalId, ext,
  });
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
  if (kind === 'transaction') {
    return { externalId: d.externalId, date: d.date, amount: num(d.amount ?? d.total), currency, category: d.category, description: d.description ?? d.label ?? '', counterparty: d.counterparty ?? d.party ?? '', direction: d.direction ?? dirOf(d.amount ?? d.total), source: d.source, type: d.type };
  }
  if (kind === 'investment') {
    return { externalId: d.externalId, date: d.date, instrument: d.instrument ?? d.label ?? '', isin: d.isin ?? '', units: num(d.units), price: num(d.price), amount: num(d.amount ?? d.total), currency, category: d.category, operation: d.operation ?? d.type, source: d.source };
  }
  if (kind === 'invoice') {
    return { externalId: d.externalId, date: d.date, total: num(d.total), currency, category: d.category, issuer: { name: d.issuer ?? d.storeName ?? d.party ?? '', address: d.issuerAddress ?? d.storeAddress ?? '' }, number: d.number ?? d.externalId, source: d.source, type: d.type };
  }
  // receipt@1 (default) — unchanged shape.
  return { externalId: d.externalId, date: d.date, total: d.total, currency, category: d.category, store: { name: d.storeName, address: d.storeAddress }, source: d.source, type: d.type };
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
// Document-level filter: only send docs whose category the sink accepts.
export function acceptsDoc(sink, doc) {
  const a = sink && sink.accepts;
  if (!a || !(a.categories && a.categories.length)) return true;
  return a.categories.includes(doc.category);
}
export function toRecords(docs, files) {
  return docs.map((d) => ({ ...toRecord(d), pdf: files.has(d.externalId) }));
}
// Merge new records into an existing manifest array by externalId (new wins), newest first.
export function mergeRecords(existing, incoming) {
  const map = new Map();
  for (const r of existing || []) if (r && r.externalId) map.set(r.externalId, r);
  for (const r of incoming) map.set(r.externalId, r);
  return [...map.values()].sort((a, b) => ((a.date || '') < (b.date || '') ? 1 : -1));
}
export function buildManifest(docs, files) {
  return JSON.stringify(toRecords(docs, files), null, 2);
}
export function jsonBlob(s) { return new Blob([s], { type: 'application/json' }); }
export function today() { return new Date().toISOString().slice(0, 10); }
