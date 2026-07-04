import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftAdapterFromSamples } from '../src/runtime/infer.js';
import { validateAdapter } from '../src/adapters/validate.js';

const carrefourSamples = [
  { url: 'https://pro.api.carrefour.es/md-purchasesAccount-v1/purchases?from=2023&to=2026&count=50', method: 'GET', status: 200,
    reqHeaders: { authorization: 'bearer eyJx', 'x-xsrf-token': 'a', 'x-csrf-token': 'b', requestorigin: 'web', 'content-type': 'application/json' },
    json: { purchases: [
      { purchaseId: 'P1', purchaseDate: '2026-01-02', amount: 12.34, mallName: 'Carrefour Aldaia', purchaseType: 'HYPERMARKET' },
      { purchaseId: 'P2', purchaseDate: '2026-01-05', amount: 5, mallName: 'Carrefour Market', purchaseType: 'SUPERMARKET' },
    ], offsets: { ticketOffset: 2 } } },
  { url: 'https://pro.api.carrefour.es/md-userAccount-v1/profile', method: 'GET', status: 200, reqHeaders: {}, json: { name: 'A' } },
];

test('picks the biggest list, its itemsPath, and a valid draft', () => {
  const r = draftAdapterFromSamples(carrefourSamples, { domain: 'carrefour.es', pageHost: 'www.carrefour.es' });
  assert.ok(r.ok);
  assert.equal(r.itemsPath, 'purchases');
  assert.equal(r.host, 'pro.api.carrefour.es');
  assert.ok(validateAdapter(r.draft).ok);
});

test('guesses field mapping from key names', () => {
  const r = draftAdapterFromSamples(carrefourSamples, { domain: 'carrefour.es', pageHost: 'www.carrefour.es' });
  assert.equal(r.draft.fields.externalId, 'purchaseId');
  assert.equal(r.draft.fields.date, 'purchaseDate');
  assert.equal(r.draft.fields.total, 'amount');
  assert.equal(r.draft.fields.storeName, 'mallName');
});

test('detects offsets pagination', () => {
  const r = draftAdapterFromSamples(carrefourSamples, { domain: 'carrefour.es', pageHost: 'www.carrefour.es' });
  assert.equal(r.draft.api.list.paging, 'offsets');
  assert.equal(r.draft.api.list.offsetsPath, 'offsets');
});

test('detects cursor pagination via a nextCursor field', () => {
  const s = [{ url: 'https://api.x.es/tx', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { transactions: [{ id: '1', valueDate: '2026-01-01', amount: 1 }], paging: { nextCursor: 'c2' } } }];
  const r = draftAdapterFromSamples(s, { domain: 'x.es', pageHost: 'www.x.es' });
  assert.equal(r.draft.api.list.paging, 'cursor');
  assert.equal(r.draft.api.list.nextPath, 'paging.nextCursor');
});

// TDD: page pagination is inferred when the request carries a `page` query param and the response
// has neither a cursor nor an offsets object.
test('detects page pagination from a `page` query param', () => {
  const s = [{ url: 'https://api.shop.es/v1/orders?page=1&count=20', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ orderId: 'O1', createdAt: '2026-01-01', totalEur: 9 }] } }];
  const r = draftAdapterFromSamples(s, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'page');
  assert.equal(r.draft.api.list.pageParam, 'page');
});
