// IKEA España — purchases via GraphQL (cross-domain cssom-prod.ingka.com) + the receipt PDF delivered
// BASE64 inside a GraphQL JSON field (api.pdf.base64Field = data.receipt.receiptPdf). Exercises: a POST
// list with a GraphQL query body + nested itemsPath, and a POST-generated document decoded from base64 —
// crucially that the GraphQL body's own `{ … }` braces survive templating while {internalId} is filled.
// All values here are INVENTED — never the user's real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, fetchPdf, artifactKinds, documentExt } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/ikea-es.json'), 'utf8'));

const auth = { byPath: {}, merged: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.INVENTED.sig' } };

const HISTORY = { data: { historyData: { totalPurchases: 2, historicalPurchases: [
  { id: '9900000000000000000001', dateAndTime: { date: '2026-01-24' }, status: 'COMPLETED', storeName: 'IKEA Test', totalCost: { code: 'EUR', value: 29, formatted: '29,00 €' }, type: 'RECEIPT' },
  { id: '1500000001', dateAndTime: { date: '2025-12-13' }, status: 'COMPLETED', storeName: 'ONLINE', totalCost: { code: 'EUR', value: 67.79, formatted: '67,79 €' }, type: 'ORDER' },
] } } };

const REAL_PDF = '%PDF-1.4 invented receipt\n%%EOF';
const B64 = Buffer.from(REAL_PDF).toString('base64');

test('ikea-es: valid + declares a PDF document', () => {
  const v = validateAdapter(SRC);
  assert.ok(v.ok, 'validate: ' + (v.errors || []).join('; '));
  assert.equal(documentExt(SRC), 'pdf');
  assert.deepEqual(artifactKinds(SRC, { internalId: 'x', _raw: {} }), [{ kind: 'document', ext: 'pdf' }]);
});

test('ikea-es: lists purchases (online + store) from the GraphQL response', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => HISTORY });
  const docs = await listInventory(SRC, auth);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].internalId, '9900000000000000000001');
  assert.equal(docs[0].total, 29);
  assert.equal(docs[0].type, 'RECEIPT');
  assert.equal(docs[1].type, 'ORDER'); // online order also listed
});

test('ikea-es: PDF decoded from base64; GraphQL braces survive, {internalId} filled', async () => {
  let sentBody = null;
  globalThis.fetch = async (u, i) => { sentBody = i.body; return { ok: true, status: 200, text: async () => JSON.stringify({ data: { receipt: { id: 'x', receiptPdf: B64 } } }) }; };
  const blob = await fetchPdf(SRC, auth, { internalId: '9900000000000000000001', _raw: {} });
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.toString(), REAL_PDF); // exact round-trip
  assert.match(sentBody, /"receiptNumber":"9900000000000000000001"/); // id substituted
  assert.match(sentBody, /receipt\(receiptNumber: \$receiptNumber\) \{ id print receiptPdf/); // GraphQL braces intact
});

test('ikea-es: an item with no receipt (null base64) is metadata-only, not an error blob', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { receipt: { receiptPdf: null } } }) });
  await assert.rejects(() => fetchPdf(SRC, auth, { internalId: '1500000001', _raw: {} }), /no document/);
});
