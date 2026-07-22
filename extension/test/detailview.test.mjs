import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailView, hasDetail } from '../src/lib/detailview.js';

// The stored JSON detail (an Amazon order) → a normalized view the drawer renders: line items + meta.
test('detailView normalizes an order detail into items + known meta fields', () => {
  const v = detailView({
    orderId: '111-2222222-3333333',
    date: '2025-03-15',
    total: 24.99,
    currency: 'EUR',
    paymentMethod: 'WiZink Classic Plus',
    paymentLast4: '4321',
    returnStatus: 'Devolución completada',
    refundTotal: 3.3,
    items: [
      { asin: 'B01ABCDEFG', title: 'Widget de Prueba Uno', price: 9.99, returned: '' },
      { asin: 'B09ZZ12345', title: 'Cosa de Prueba Dos', price: 15, returned: 'Devolución completada' },
    ],
  });
  assert.equal(v.currency, 'EUR');
  assert.deepEqual(v.items, [
    { name: 'Widget de Prueba Uno', price: 9.99, returned: '' },
    { name: 'Cosa de Prueba Dos', price: 15, returned: 'Devolución completada' },
  ]);
  assert.deepEqual(v.meta, { paymentMethod: 'WiZink Classic Plus', paymentLast4: '4321', returnStatus: 'Devolución completada', refundTotal: 3.3 });
  assert.equal(hasDetail(v), true);
});

test('detailView falls back to asin/name for an item title and drops empty items', () => {
  const v = detailView({ items: [{ asin: 'B000000001', price: 5 }, { name: 'Bare' }, {}, { price: '' }] });
  assert.deepEqual(v.items, [{ name: 'B000000001', price: 5, returned: '' }, { name: 'Bare', price: null, returned: '' }]);
});

test('detailView keeps only the known meta keys (ignores unknown fields) and treats 0 as a real value', () => {
  const v = detailView({ paymentMethod: 'Visa', someOther: 'ignored' });
  assert.deepEqual(v.meta, { paymentMethod: 'Visa' }); // unknown "someOther" is dropped
  assert.deepEqual(detailView({ refundTotal: 0 }).meta, { refundTotal: 0 }); // a 0 € refund is meaningful → kept
});

test('hasDetail is false for an empty/garbage detail (nothing to render)', () => {
  assert.equal(hasDetail(detailView({})), false);
  assert.equal(hasDetail(detailView(null)), false);
  assert.equal(hasDetail(detailView({ items: [] })), false);
  assert.equal(hasDetail(detailView('nonsense')), false);
});
