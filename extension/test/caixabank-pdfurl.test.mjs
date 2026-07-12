// A `pdf.urlField` source (CaixaBank: the statement's absolute `Url` lives only on the raw list item).
// Rows loaded from the store lose `_raw`, so the PDF url is persisted onto the record (record.pdfUrl) and
// used as a fallback — re-validated to the source domain on every fetch (a persisted/imported URL isn't
// trusted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord } from '../src/sinks/format.js';
import { artifactKinds, fetchArtifact } from '../src/runtime/inventory.js';

const adapter = { id: 'bank-es', domain: 'bank.es', schema: 'invoice@1', api: { host: 'https://www.bank.es', pdf: { urlField: 'Url', ext: 'pdf' } }, fields: {} };
const storeRow = (pdfUrl) => ({ internalId: 'C1', record: pdfUrl ? { pdfUrl } : {}, _fromStore: true });

test('buildRecord persists the absolute PDF url as record.pdfUrl (urlField source)', () => {
  const r = buildRecord({ internalId: 'C1', date: '2026-01-01', total: 5, _raw: { Codigo: 'C1', Url: 'https://www.bank.es/dl/C1.pdf' } }, adapter);
  assert.equal(r.pdfUrl, 'https://www.bank.es/dl/C1.pdf');
});

test('buildRecord adds no pdfUrl for a source without urlField (byte-identical)', () => {
  const r = buildRecord({ internalId: 'C1', date: '2026-01-01', total: 5, _raw: { x: 1 } }, { schema: 'receipt@1', api: { pdf: { path: '/x/{internalId}', ext: 'pdf' } } });
  assert.ok(!('pdfUrl' in r));
});

test('artifactKinds: a store row with a persisted pdfUrl can still fetch the document', () => {
  assert.ok(artifactKinds(adapter, storeRow('https://www.bank.es/dl/C1.pdf')).some((k) => k.kind === 'document'));
});

test('artifactKinds: a store row WITHOUT pdfUrl has no document', () => {
  assert.ok(!artifactKinds(adapter, storeRow(null)).some((k) => k.kind === 'document'));
});

test('fetchArtifact fetches the persisted pdfUrl for a store row (no _raw)', async () => {
  let got = '';
  const net = async (u) => { got = String(u); return { ok: true, status: 200, blob: async () => new Blob(['%PDF-1'], { type: 'application/pdf' }) }; };
  const r = await fetchArtifact(adapter, { byPath: {}, merged: {} }, storeRow('https://www.bank.es/dl/C1.pdf'), net, null, 'document');
  assert.equal(got, 'https://www.bank.es/dl/C1.pdf');
  assert.ok(r && r.blob);
});

test('fetchArtifact rejects a persisted pdfUrl on a disallowed host (re-validated, not trusted)', async () => {
  const net = async () => ({ ok: true, status: 200, blob: async () => new Blob([]) });
  await assert.rejects(() => fetchArtifact(adapter, { byPath: {}, merged: {} }, storeRow('https://evil.com/C1.pdf'), net, null, 'document'), /not allowed/);
});
