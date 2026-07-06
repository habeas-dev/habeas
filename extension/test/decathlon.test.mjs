import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInventory, fetchDocument } from '../src/runtime/inventory.js';

// Faithful reproduction of Decathlon's gating (reverse-engineered from the real curls):
//  - LIST  GET /web-engage/ajax/myPurchase?from=N&size=9  → 9 items/page, offset paging, BUT the
//          offset is only honoured when the request carries the `dkt-ecom-origin` header AND a
//          Referer whose ?page= matches the offset (page = from/9 + 1). Otherwise it serves page 1
//          (which is exactly why a naive pager dedupes to 9 and stops).
//  - DETAIL GET /web-engage/ajax/order?associationId=UUID&orderManager=cube → order JSON, but 500
//          {"name":"InvalidInputParameters"} unless the Referer is the item's orderTracking page
//          (transactionId=UUID) AND the header is present.
const N = 27; // three pages of 9
// The list item's id used in the detail URL is `associationId` (the verified field — NOT
// orderTransactionId, which is a different id that the order endpoint rejects with InvalidInputParameters).
const item = (i) => ({ associationId: 'uuid-' + i, orderTransactionId: 'other-' + i, orderNumber: 'F-' + i, orderDate: '2026-01-0' + ((i % 9) + 1), orderTotalPrice: 10 + i, orderOrigin: 'store' });
const page = (from) => (from >= N ? [] : Array.from({ length: Math.min(9, N - from) }, (_, k) => item(from + k)));
const resp = (json, status = 200) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });

function decathlonNet(url, init) {
  const u = new URL(url);
  const hdrOk = (init.headers || {})['dkt-ecom-origin'] === 'web-navigate-front';
  const ref = init.referrer || '';
  if (u.pathname === '/web-engage/ajax/myPurchase') {
    const from = Number(u.searchParams.get('from') || 0);
    const expectPage = from / 9 + 1;
    if (!hdrOk || !ref.includes('page=' + expectPage)) return resp({ items: page(0) }); // gate → page 1
    return resp({ items: page(from) });
  }
  if (u.pathname === '/web-engage/ajax/order') {
    const id = u.searchParams.get('associationId');
    if (!hdrOk || !ref.includes('transactionId=' + id)) return resp({ name: 'InvalidInputParameters', message: '', status: 500 }, 500);
    return resp({ orderTransactionId: id, orderNumber: 'F', lines: [{ sku: 'x' }], orderTotalPrice: 5 });
  }
  return resp({}, 404);
}

const ADAPTER = {
  id: 'decathlon-es', name: 'Decathlon', service: 'decathlon', trust: 'community', domain: 'decathlon.es',
  categories: ['other'], match: ['https://decathlon.es/*'], auth: { mode: 'cookie', replayHeaders: [] },
  api: {
    host: 'https://www.decathlon.es',
    list: {
      path: '/web-engage/ajax/myPurchase', paging: 'offset', itemsPath: 'items',
      offsetParam: 'from', offsetStart: 0, offsetStep: 9, params: { size: '9' },
      headers: { 'dkt-ecom-country': 'ES', 'dkt-ecom-origin': 'web-navigate-front', 'content-type': 'application/json' },
      referer: 'https://www.decathlon.es/es/account/myPurchase?page={page}',
    },
    detail: {
      path: '/web-engage/ajax/order?associationId={internalId}&orderManager=cube', method: 'GET',
      headers: { 'dkt-ecom-country': 'ES', 'dkt-ecom-origin': 'web-navigate-front', 'content-type': 'application/json' },
      referer: 'https://www.decathlon.es/es/account/orderTracking?transactionId={internalId}&type=store',
    },
  },
  fields: { internalId: 'associationId', number: 'orderNumber', date: 'orderDate', total: 'orderTotalPrice', storeName: 'orderOrigin' },
  schema: 'receipt@1',
};
const AUTH = { byPath: {}, merged: {} };

test('Decathlon: the real adapter paginates ALL orders through the header+per-page-referer gate', async () => {
  const docs = await listInventory(ADAPTER, AUTH, decathlonNet);
  assert.equal(docs.length, N, `expected ${N} across 3 pages, got ${docs.length}`);
  assert.equal(new Set(docs.map((d) => d.internalId)).size, N); // all distinct → real pagination, not page 1 repeated
});

test('Decathlon: the per-page Referer is what unlocks pagination (drop it → stuck on page 1)', async () => {
  const broken = JSON.parse(JSON.stringify(ADAPTER)); delete broken.api.list.referer;
  const docs = await listInventory(broken, AUTH, decathlonNet);
  assert.equal(docs.length, 9); // gate serves page 1 → dedup → stops. Proves the referer is required.
});

test('Decathlon: detail fetch succeeds with the item-page Referer + header (no InvalidInputParameters)', async () => {
  const docs = await listInventory(ADAPTER, AUTH, decathlonNet);
  const { blob, via } = await fetchDocument(ADAPTER, AUTH, docs[5], decathlonNet);
  assert.equal(via, 'json');
  const detail = JSON.parse(await blob.text());
  assert.equal(detail.orderTransactionId, docs[5].internalId); // right order, narrowed
});

test('Decathlon: without the detail Referer it 500s (InvalidInputParameters) — the gate we reproduce', async () => {
  const broken = JSON.parse(JSON.stringify(ADAPTER)); delete broken.api.detail.referer;
  const docs = await listInventory(ADAPTER, AUTH, decathlonNet);
  await assert.rejects(fetchDocument(broken, AUTH, docs[0], decathlonNet), /detail 500|InvalidInputParameters/);
});
