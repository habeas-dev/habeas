// Shared formatting helpers used by every sink.
import { renderPath } from '../lib/naming.js';

export function pathFor(sink, d, opts) {
  const tpl = sink.pathTemplate || '{service}/{yyyy}/{date}-{externalId}.pdf';
  return renderPath(tpl, {
    service: opts.service || 'documents',
    date: (d.date || '').slice(0, 10),
    externalId: d.externalId, ext: 'pdf',
  });
}
export function toRecord(d) {
  return { externalId: d.externalId, date: d.date, total: d.total, currency: 'EUR', category: d.category, store: { name: d.storeName, address: d.storeAddress }, source: d.source, type: d.type };
}

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
