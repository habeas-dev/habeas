// Two runtime features for JSON lists that return a top-level array mixing kinds (e.g. Leroy Merlin's
// /order-followup orders return ONLINE + IN_STORE in a bare array):
//   - itemsPath "$" → the response IS the array (no wrapper object)
//   - list.keep {field, values} → keep only items whose field value is in the set
// Synthetic fixture (invented values; never a real capture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInventory } from '../src/runtime/inventory.js';

const ORDERS = [
  { orderPartNumber: 'A-1', orderPlaceType: 'ONLINE', parentOrder: { createdAt: '2026-02-02T18:53:22.622Z' }, price: { totalAmount: 43.8 }, vendors: [{ id: '9', name: 'Acme' }] },
  { orderPartNumber: 'S-2', orderPlaceType: 'IN_STORE', parentOrder: { createdAt: '2024-05-03T17:20:58Z' }, price: { totalAmount: 68.67 }, vendors: [] },
  { orderPartNumber: 'A-3', orderPlaceType: 'ONLINE', parentOrder: { createdAt: '2023-02-17T10:00:00Z' }, price: { totalAmount: 34.14 }, vendors: [] },
];
const ADAPTER = {
  id: 'x', name: 'X', service: 'x', domain: 'shop.es', match: ['https://shop.es/*'],
  categories: ['diy'], schema: 'receipt@1', itemLabel: 'Pedido {internalId}',
  auth: { mode: 'cookie', replayHeaders: [] },
  api: { host: 'https://shop.es', list: { path: '/orders', paging: 'none', itemsPath: '$', keep: { field: 'orderPlaceType', values: ['ONLINE'] } } },
  fields: { internalId: 'orderPartNumber', date: 'parentOrder.createdAt', total: 'price.totalAmount', storeName: 'vendors.0.name' },
};
const net = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(ORDERS), json: async () => ORDERS });

test('itemsPath "$" reads a top-level array; list.keep filters to matching items', async () => {
  const docs = await listInventory(ADAPTER, { byPath: {}, merged: {} }, net, {});
  assert.deepEqual(docs.map((d) => d.internalId), ['A-1', 'A-3'], 'only ONLINE orders kept, from the bare array');
  assert.equal(docs[0].total, 43.8);
  assert.equal(docs[0].date, '2026-02-02');
  assert.equal(docs[0].storeName, 'Acme');        // dotted + array-index field path
  assert.equal(docs[1].label, 'Pedido A-3');       // no vendor → itemLabel fallback
});

test('no keep → every item in the top-level array is returned', async () => {
  const a = { ...ADAPTER, api: { ...ADAPTER.api, list: { path: '/orders', paging: 'none', itemsPath: '$' } } };
  const docs = await listInventory(a, { byPath: {}, merged: {} }, net, {});
  assert.deepEqual(docs.map((d) => d.internalId), ['A-1', 'S-2', 'A-3']);
});
