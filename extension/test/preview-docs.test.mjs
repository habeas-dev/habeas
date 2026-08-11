import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewDocs } from '../src/runtime/inventory.js';

// The recorder used to show an empty table until the user pressed "Test", which needs a live session and
// a network round-trip. The items are already captured, and mapDoc is pure — so the review step can show
// the real rows straight away. All data synthetic.

const ADAPTER = {
  id: 'demo', schema: 'transaction@1',
  api: { host: 'api.demo.test', list: { path: '/mov', itemsPath: 'movements' } },
  fields: { internalId: 'id', date: 'fecha', amount: 'importe', currency: 'divisa', description: 'concepto' },
};

test('captured items map to the same rows a real listing would produce', () => {
  const docs = previewDocs(ADAPTER, [
    { id: 'MV-1', fecha: '04/05/2026', importe: '-61,20 €', divisa: 'EUR', concepto: 'Recibo de luz' },
    { id: 'MV-2', fecha: '2026-05-06', importe: -13, divisa: 'EUR', concepto: 'Compra online' },
  ]);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].internalId, 'MV-1');
  assert.equal(docs[0].date, '2026-05-04', 'a localised date should be normalised, as in a real run');
  assert.equal(docs[0].amount, -61.2, 'a formatted amount should be parsed, as in a real run');
  assert.equal(docs[0].label, 'Recibo de luz', 'the row needs a human label');
  assert.ok(docs[0].record, 'the normalized record is what a sink would receive');
});

test('the preview is capped so a 5000-item capture cannot lock up the page', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: 'T' + i, fecha: '2026-01-01', importe: 1, concepto: 'x' }));
  assert.ok(previewDocs(ADAPTER, many).length <= 500);
});

test('a bad item is skipped rather than taking the whole preview down with it', () => {
  const docs = previewDocs(ADAPTER, [null, { id: 'O', fecha: '2026-01-02', importe: 3, concepto: 'ok' }]);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].internalId, 'O');
});

test('no items, no rows', () => {
  assert.deepEqual(previewDocs(ADAPTER, []), []);
  assert.deepEqual(previewDocs(ADAPTER, null), []);
});
