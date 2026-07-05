import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftAdapterFromSamples, listCandidates, matchCandidates } from '../src/runtime/infer.js';
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

// Search-by-value: a non-technical user types a ticket no. / amount to pick the right list.
const twoLists = [
  { url: 'https://api.shop.es/v1/orders?page=1', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ orderId: 'A-100', total: 12.5 }, { orderId: 'A-101', total: 7 }] } },
  { url: 'https://api.shop.es/v1/recommendations', status: 200, reqHeaders: {},
    json: { products: [{ sku: 'X1' }, { sku: 'X2' }, { sku: 'X3' }, { sku: 'X4' }] } },
];

test('matchCandidates finds the list containing a recognised value', () => {
  const m = matchCandidates(twoLists, 'A-101');
  assert.equal(m.length, 1);
  assert.equal(m[0].itemsPath, 'items');
  // biggest list is recommendations, but search picks orders by value
  assert.notEqual(m[0].key, listCandidates(twoLists)[0].key);
});

test('matchCandidates matches an amount too', () => {
  assert.equal(matchCandidates(twoLists, '12.5')[0].itemsPath, 'items');
  assert.equal(matchCandidates(twoLists, 'nope').length, 0);
});

test('pages of the same list dedupe to one candidate', () => {
  const paged = [
    { url: 'https://api.shop.es/v1/orders?page=1', status: 200, reqHeaders: {}, json: { items: [{ orderId: 'A-1' }] } },
    { url: 'https://api.shop.es/v1/orders?page=2', status: 200, reqHeaders: {}, json: { items: [{ orderId: 'A-2' }, { orderId: 'A-3' }] } },
  ];
  const cands = listCandidates(paged);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].count, 3); // aggregated across pages: A-1 + A-2 + A-3
  assert.equal(cands[0].pages, 2); // two pages captured
});

test('infers a JSON detail endpoint (preferred document) from a per-order detail response', () => {
  const samples = [
    { url: 'https://api.shop.es/v1/orders?page=1', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { items: [{ id: 'ORD-7', total: 5 }, { id: 'ORD-8', total: 9 }] } },
    { url: 'https://api.shop.es/v1/orders/ORD-8', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { id: 'ORD-8', lines: [{ sku: 'a' }], total: 9 } },
  ];
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.ok(r.draft.api.detail, 'detail inferred');
  assert.equal(r.draft.api.detail.path, '/v1/orders/{externalId}');
  assert.ok(!r.draft.api.pdf, 'no PDF when detail present');
});

test('externalId is the internal id used in the URL, not the human-facing receipt number', () => {
  const samples = [
    { url: 'https://api.shop.es/v1/orders', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { items: [{ number: 'F-2026-0007', ref: 'abc-123-def', total: 5 }] } },
    { url: 'https://api.shop.es/v1/orders/abc-123-def', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { ref: 'abc-123-def', number: 'F-2026-0007', lines: [] } },
  ];
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.detail.path, '/v1/orders/{externalId}');
  assert.equal(r.draft.fields.externalId, 'ref'); // the URL id, not 'number' (the visible receipt no.)
});

test('rendered page text distinguishes the public (visible) number from the internal id', () => {
  const samples = [{ url: 'https://api.shop.es/v1/orders', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ id: 'u-abc-999', receiptId: 'R-2026-42', total: 5 }] } }];
  const domTexts = ['Mis pedidos\nPedido R-2026-42 · 5€']; // the user sees the receipt no., not the uuid
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es', domTexts });
  assert.equal(r.draft.fields.externalId, 'id');        // internal (not rendered)
  assert.equal(r.draft.fields.number, 'receiptId');     // public (rendered)
});

test('infers a POST-generated PDF (body templated by id) from captured assets', () => {
  const samples = [{ url: 'https://api.shop.es/v1/orders', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ id: 'ORD-8', total: 9 }] } }];
  const assets = [{ url: 'https://api.shop.es/v1/pdf', method: 'POST', reqType: 'application/json', reqBody: '{"orderId":"ORD-8"}', status: 200 }];
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es', assets });
  assert.equal(r.draft.api.pdf.method, 'POST');
  assert.equal(r.draft.api.pdf.body, '{"orderId":"{externalId}"}');
});

test('pagination cursor/page is stripped from captured params (starts from the beginning)', () => {
  const cursor = [{ url: 'https://api.shop.es/v1/tx?cursor=PAGE3TOKEN&limit=50', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { transactions: [{ id: 't9', valueDate: '2026-03-09', amount: -3 }], paging: { nextCursor: 'c4' } } }];
  const r = draftAdapterFromSamples(cursor, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'cursor');
  assert.ok(!('cursor' in (r.draft.api.list.params || {})), 'cursor param must be stripped');
  assert.equal(r.draft.api.list.params.limit, '50'); // page-size param stays
});
