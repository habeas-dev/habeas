import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemPreview, listCandidates } from '../src/runtime/infer.js';

// The list picker used to identify each captured list by API path and host — "/v1/movements ·
// api.example.test". Nobody recognises their own purchases that way. These cover the one-line preview
// of a real item that replaces it. All data below is synthetic.

test('a preview reads like the row the user saw on the site', () => {
  const p = itemPreview({
    id: 'MV-8891', fecha: '2026-04-17', importe: -24.5, divisa: 'EUR', concepto: 'Compra en Tienda Azul',
  });
  assert.match(p, /2026-04-17/);
  assert.match(p, /Compra en Tienda Azul/);
  assert.match(p, /24[.,]5/);
});

test('the description wins over an opaque id', () => {
  const p = itemPreview({ orderId: '0f2c9a71-4d3b', merchantName: 'Panadería Nueve', total: 12.4 });
  assert.match(p, /Panadería Nueve/);
  assert.ok(!p.includes('0f2c9a71'), `an internal id is not a recogniseable label: ${p}`);
});

test('a long description is cut rather than allowed to blow up the dropdown', () => {
  const p = itemPreview({ date: '2026-01-02', description: 'X'.repeat(200), amount: 1 });
  assert.ok(p.length < 90, `preview too long (${p.length}): ${p}`);
});

test('an item with nothing recogniseable yields nothing, not a broken half-line', () => {
  assert.equal(itemPreview({}), '');
  assert.equal(itemPreview(null), '');
  assert.equal(itemPreview({ flags: { a: true }, nested: { b: {} } }), '');
});

test('nested fields are reachable — the label is often one level down', () => {
  const p = itemPreview({ id: 'A1', date: '2026-02-03', store: { name: 'Mercado Doce' }, total: 9.9 });
  assert.match(p, /Mercado Doce/);
});

test('listCandidates carries the preview, so the picker can show data instead of a URL', () => {
  const items = [
    { id: 'T1', fecha: '2026-05-04', concepto: 'Recibo de luz', importe: -61.2 },
    { id: 'T2', fecha: '2026-05-06', concepto: 'Compra online', importe: -13.0 },
  ];
  const cands = listCandidates([{ url: 'https://api.example.test/v1/movements', json: { movements: items } }]);
  assert.ok(cands.length, 'expected a candidate list');
  assert.match(cands[0].preview, /Recibo de luz/);
});
