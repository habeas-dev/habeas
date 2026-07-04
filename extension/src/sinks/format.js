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
  return { externalId: d.externalId, date: d.date, total: d.total, currency: 'EUR', store: { name: d.storeName, address: d.storeAddress }, source: d.source, type: d.type };
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
