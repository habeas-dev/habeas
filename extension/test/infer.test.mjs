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
  assert.equal(r.draft.fields.internalId, 'purchaseId');
  assert.equal(r.draft.fields.date, 'purchaseDate');
  assert.equal(r.draft.fields.total, 'amount');
  assert.equal(r.draft.fields.storeName, 'mallName');
});

test('detects offsets pagination', () => {
  const r = draftAdapterFromSamples(carrefourSamples, { domain: 'carrefour.es', pageHost: 'www.carrefour.es' });
  assert.equal(r.draft.api.list.paging, 'offsets');
  assert.equal(r.draft.api.list.offsetsPath, 'offsets');
});

test('auto-detects an SSR embedded list (fromHtml) + a detail with per-item params (Dia-shape)', () => {
  const it = (ticket) => ({ detail_params: { begin: 1780328485000, business: 1, country: 'ES', pos: 2, store: 15500, ticket }, submitted_date: '2026-06-01T15:41:25Z', total_amount: 9.77, store_info: { city: 'Cobeña' } });
  const samples = [
    // The list is embedded in the page's SSR state (Vike) — bridge posts it as a fromHtml sample.
    { url: 'https://www.dia.es/my-account/tickets', method: 'GET', status: 200, reqHeaders: {}, fromHtml: true, json: { INITIAL_STATE: { ticketsList: [it(464414), it(460615)] } } },
    // The detail XHR the user triggered by opening a ticket — id in the path, per-item params in the query.
    { url: 'https://www.dia.es/api/v3/eservice-back/customer/current/tickets/464414?begin=1780328485000&business=1&country=ES&pos=2&store=15500', method: 'GET', status: 200, reqHeaders: {}, json: { header: { code: 464414 }, total_amount: 9.77 } },
  ];
  const { ok, draft } = draftAdapterFromSamples(samples, { domain: 'dia.es', pageHost: 'www.dia.es' });
  assert.ok(ok);
  assert.equal(draft.api.list.from, 'html'); // read from embedded page state, not an XHR
  assert.equal(draft.api.list.itemsPath, 'INITIAL_STATE.ticketsList');
  assert.equal(draft.fields.internalId, 'detail_params.ticket');
  assert.equal(draft.api.detail.path,
    '/api/v3/eservice-back/customer/current/tickets/{internalId}?begin={detail_params.begin}&business={detail_params.business}&country={detail_params.country}&pos={detail_params.pos}&store={detail_params.store}');
});

test('detects cursor pagination via a nextCursor field', () => {
  const s = [{ url: 'https://api.x.es/tx', method: 'GET', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { transactions: [{ id: '1', valueDate: '2026-01-01', amount: 1 }], paging: { nextCursor: 'c2' } } }];
  const r = draftAdapterFromSamples(s, { domain: 'x.es', pageHost: 'www.x.es' });
  assert.equal(r.draft.api.list.paging, 'cursor');
  assert.equal(r.draft.api.list.nextPath, 'paging.nextCursor');
});

// A POST/GraphQL list: the SPA sends the query in the request BODY (Ikea's purchase-history GraphQL).
// The draft must reproduce it faithfully — method + body + content-type — not silently draft a GET.
test('drafts a POST/GraphQL list preserving method, body and content-type (Ikea-shape)', () => {
  const body = JSON.stringify({ operationName: 'FullHistory', variables: { skip: 0, take: -1 }, query: 'query FullHistory($skip: Int!, $take: Int!) { historyData(skip: $skip, take: $take) { historicalPurchases { id } } }' });
  const s = [{ url: 'https://order.ikea.com/purchase-history/graphql', method: 'POST', status: 200,
    reqHeaders: { authorization: 'bearer eyJz' }, reqBody: body,
    json: { data: { historyData: { historicalPurchases: [
      { id: 'X1', dateAndTime: { date: '2026-01-02' }, storeName: 'IKEA', totalCost: { value: '12.34' } },
      { id: 'X2', dateAndTime: { date: '2026-02-02' }, storeName: 'IKEA', totalCost: { value: '5' } },
    ] } } } }];
  const r = draftAdapterFromSamples(s, { domain: 'ikea.com', pageHost: 'www.ikea.com' });
  assert.ok(r.ok);
  assert.equal(r.draft.api.list.method, 'POST');
  assert.equal(r.draft.api.list.body, body);
  assert.equal(r.draft.api.list.contentType, 'application/json'); // body-shape detected (no content-type header captured)
  assert.equal(r.draft.api.list.itemsPath, 'data.historyData.historicalPurchases');
  assert.equal(r.draft.fields.internalId, 'id');
  assert.ok(validateAdapter(r.draft).ok);
});

// A form-urlencoded POST list (no JSON body) → content-type falls back to form encoding.
test('drafts a form-encoded POST list with the right content-type', () => {
  const s = [{ url: 'https://www.bank.es/movimientos', method: 'POST', status: 200,
    reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, reqBody: 'from=2026-01-01&to=2026-06-01',
    json: { movements: [{ id: 'M1', fecha: '2026-01-02', importe: 3 }] } }];
  const r = draftAdapterFromSamples(s, { domain: 'bank.es', pageHost: 'www.bank.es' });
  assert.equal(r.draft.api.list.method, 'POST');
  assert.equal(r.draft.api.list.body, 'from=2026-01-01&to=2026-06-01');
  assert.equal(r.draft.api.list.contentType, 'application/x-www-form-urlencoded');
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

// Learn pagination from the ACTUAL pages the user browsed (not just single-sample signals).
test('learns page pagination from several captured pages', () => {
  const p = (n) => ({ url: `https://api.shop.es/orders?page=${n}`, status: 200, reqHeaders: {}, json: { items: [{ id: 'O' + n }] } });
  const r = draftAdapterFromSamples([p(1), p(2), p(3)], { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'page');
  assert.equal(r.draft.api.list.pageParam, 'page');
});

test('learns OFFSET pagination (param `from`, step = page size) from several pages', () => {
  const p = (off, ids) => ({ url: `https://api.shop.es/orders?from=${off}&limit=2`, status: 200, reqHeaders: {}, json: { items: ids.map((id) => ({ id })) } });
  const r = draftAdapterFromSamples([p(0, ['A', 'B']), p(2, ['C', 'D']), p(4, ['E'])], { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'offset');
  assert.equal(r.draft.api.list.offsetParam, 'from');
  assert.equal(r.draft.api.list.offsetStep, 2);
  assert.equal(r.draft.api.list.offsetStart, 0);
  assert.ok(!('from' in (r.draft.api.list.params || {}))); // the offset param is stripped (start fresh)
  assert.equal(r.draft.api.list.params.limit, '2');        // page-size param stays
});

test('offset pagination starts at 0 even if page 1 (from=0) was not captured', () => {
  const p = (off) => ({ url: `https://api.shop.es/o?from=${off}&size=9`, status: 200, reqHeaders: {}, json: { items: [{ id: 'x' + off }] } });
  const r = draftAdapterFromSamples([p(9), p(18), p(27)], { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'offset');
  assert.equal(r.draft.api.list.offsetStart, 0); // not 9 — start from the beginning
  assert.equal(r.draft.api.list.offsetStep, 9);
});

test('de oficio: carries app headers + per-page/per-item Referer into the draft', () => {
  const uuid = 'abc-uuid-1';
  const samples = [
    { url: 'https://www.x.es/ajax/list?from=0', status: 200, reqHeaders: { 'dkt-ecom-origin': 'web', uzlc: '00000000000000-0000-0000-0000-000000000000-00000000000000000000-000000000000000000000000FAKE', authorization: 'eyJ' }, json: { items: [{ id: uuid, total: 5 }] } },
    { url: 'https://www.x.es/ajax/order?associationId=' + uuid, status: 200, reqHeaders: { 'dkt-ecom-origin': 'web' }, json: { id: uuid, lines: [] } },
  ];
  const domTexts = [
    { url: 'https://www.x.es/account/order?transactionId=' + uuid, text: 'Pedido' },
    { url: 'https://www.x.es/account/list?page=2', text: 'Mis pedidos' },
  ];
  const r = draftAdapterFromSamples(samples, { domain: 'x.es', pageHost: 'www.x.es', domTexts });
  assert.equal(r.draft.api.list.headers['dkt-ecom-origin'], 'web');           // app header, not auth
  assert.ok(!('uzlc' in r.draft.api.list.headers), 'ephemeral anti-bot token not hardcoded');
  assert.equal(r.draft.api.list.referer, 'https://www.x.es/account/list?page={page}');
  assert.equal(r.draft.api.detail.headers['dkt-ecom-origin'], 'web');
  assert.equal(r.draft.api.detail.referer, 'https://www.x.es/account/order?transactionId={internalId}');
});

test('learns cursor pagination: page 1 has no token, page 2 carries the response token', () => {
  const s = [
    { url: 'https://api.shop.es/tx', status: 200, reqHeaders: {}, json: { items: [{ id: '1' }], paging: { next: 'TOK2' } } },
    { url: 'https://api.shop.es/tx?cur=TOK2', status: 200, reqHeaders: {}, json: { items: [{ id: '2' }], paging: { next: 'TOK3' } } },
  ];
  const r = draftAdapterFromSamples(s, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'cursor');
  assert.equal(r.draft.api.list.cursorParam, 'cur');
  assert.equal(r.draft.api.list.nextPath, 'paging.next');
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
  assert.equal(r.draft.api.detail.path, '/v1/orders/{internalId}');
  assert.ok(!r.draft.api.pdf, 'no PDF when detail present');
});

test('internalId is the internal id used in the URL, not the human-facing receipt number', () => {
  const samples = [
    { url: 'https://api.shop.es/v1/orders', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { items: [{ number: 'F-2026-0007', ref: 'abc-123-def', total: 5 }] } },
    { url: 'https://api.shop.es/v1/orders/abc-123-def', status: 200, reqHeaders: { authorization: 'eyJ' },
      json: { ref: 'abc-123-def', number: 'F-2026-0007', lines: [] } },
  ];
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.detail.path, '/v1/orders/{internalId}');
  assert.equal(r.draft.fields.internalId, 'ref'); // the URL id, not 'number' (the visible receipt no.)
});

test('rendered page text distinguishes the public (visible) number from the internal id', () => {
  const samples = [{ url: 'https://api.shop.es/v1/orders', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ id: 'u-abc-999', receiptId: 'R-2026-42', total: 5 }] } }];
  const domTexts = ['Mis pedidos\nPedido R-2026-42 · 5€']; // the user sees the receipt no., not the uuid
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es', domTexts });
  assert.equal(r.draft.fields.internalId, 'id');        // internal (not rendered)
  assert.equal(r.draft.fields.number, 'receiptId');     // public (rendered)
});

test('detail endpoint from a navigated (SSR) page with the id in a query param', () => {
  const uuid = '47dc2ad6-7b3f-4238-8ed9-5888c399a347';
  const samples = [{ url: 'https://www.decathlon.es/api/orders', status: 200, reqHeaders: {},
    json: { items: [{ transactionId: uuid, number: '12345', total: 9 }] } }];
  const domTexts = [{ url: `https://www.decathlon.es/es/account/orderTracking?transactionId=${uuid}&type=store`, text: 'Mis pedidos\nPedido 12345 · 9€' }];
  const r = draftAdapterFromSamples(samples, { domain: 'decathlon.es', pageHost: 'www.decathlon.es', domTexts });
  assert.ok(r.draft.api.detail, 'detail inferred from the navigated page');
  assert.equal(r.draft.api.detail.path, '/es/account/orderTracking?transactionId={internalId}&type=store');
  assert.equal(r.draft.fields.internalId, 'transactionId'); // internal uuid (in the URL, not rendered)
  assert.equal(r.draft.fields.number, 'number');             // 12345 is rendered → public
});

test('infers a POST-generated PDF (body templated by id) from captured assets', () => {
  const samples = [{ url: 'https://api.shop.es/v1/orders', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { items: [{ id: 'ORD-8', total: 9 }] } }];
  const assets = [{ url: 'https://api.shop.es/v1/pdf', method: 'POST', reqType: 'application/json', reqBody: '{"orderId":"ORD-8"}', status: 200 }];
  const r = draftAdapterFromSamples(samples, { domain: 'shop.es', pageHost: 'www.shop.es', assets });
  assert.equal(r.draft.api.pdf.method, 'POST');
  assert.equal(r.draft.api.pdf.body, '{"orderId":"{internalId}"}');
});

test('pagination cursor/page is stripped from captured params (starts from the beginning)', () => {
  const cursor = [{ url: 'https://api.shop.es/v1/tx?cursor=PAGE3TOKEN&limit=50', status: 200, reqHeaders: { authorization: 'eyJ' },
    json: { transactions: [{ id: 't9', valueDate: '2026-03-09', amount: -3 }], paging: { nextCursor: 'c4' } } }];
  const r = draftAdapterFromSamples(cursor, { domain: 'shop.es', pageHost: 'www.shop.es' });
  assert.equal(r.draft.api.list.paging, 'cursor');
  assert.ok(!('cursor' in (r.draft.api.list.params || {})), 'cursor param must be stripped');
  assert.equal(r.draft.api.list.params.limit, '50'); // page-size param stays
});
