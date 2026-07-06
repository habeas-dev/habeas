import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import carrefour from '../src/adapters/carrefour-es.js';
import mart from './fixtures/examplemart-es.js';
import bank from './fixtures/examplebank-es.js';
import energy from './fixtures/exampleenergy-es.js';
import { listInventory, fetchDocument, fetchDetail } from '../src/runtime/inventory.js';

const auth = { authorization: 'bearer eyJx' };
function stub(pages) {
  let i = 0; const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return { ok: true, json: async () => pages[Math.min(i++, pages.length - 1)], text: async () => '' }; };
  return urls;
}

test('carrefour offsets paging: query is byte-identical to the historical shape', async () => {
  const urls = stub([
    { purchases: [{ purchaseId: 'P1', purchaseDate: '2026-01-02', amount: 12.34, mallName: 'S', mallAddress: 'A', purchaseType: 'HYPERMARKET' }], offsets: { ticketOffset: 1 } },
    { purchases: [], offsets: {} },
  ]);
  const docs = await listInventory(carrefour, auth);
  const qs = urls[0].split('?')[1].replace(/from=[^&]+&to=[^&]+/, 'from=X&to=X');
  assert.equal(qs, 'from=X&to=X&count=50&ticketOffset=0&atgfOffset=0&atgnfOffset=0&currentTickets=0&currentAtgfOrders=0&currentAtgnfOrders=0');
  assert.deepEqual(docs[0].record, { internalId: 'P1', date: '2026-01-02', total: 12.34, currency: 'EUR', category: 'grocery', store: { name: 'S', address: 'A' }, source: undefined, type: 'HYPERMARKET' });
});

test('page paging stops on a partial page', async () => {
  stub([
    { data: { items: [{ id: 'a', purchasedAt: '2026-02-01', amount: 10, store: { name: 'S1' }, channel: 'STORE' }, { id: 'b', purchasedAt: '2026-02-02', amount: 20, store: { name: 'S2' }, channel: 'ONLINE' }] } },
    { data: { items: [{ id: 'c', purchasedAt: '2026-02-03', amount: 30, store: { name: 'S3' }, channel: 'STORE' }] } },
  ]);
  mart.api.list.params.count = 2;
  const docs = await listInventory(mart, auth);
  assert.equal(docs.length, 3);
  assert.deepEqual(docs.map((d) => d.category).sort(), ['grocery', 'grocery', 'retail']);
});

test('html list: parses items from a server-rendered table (from:html), incl. row links', async () => {
  const html = `<table><tr><th>Date</th><th>Amount</th><th></th></tr>
    <tr><td>2026-01-02</td><td>10.00</td><td><a href="/receipts/A1.pdf">PDF</a></td></tr>
    <tr><td>2026-01-05</td><td>7.50</td><td><a href="/receipts/A2.pdf">PDF</a></td></tr></table>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => html, json: async () => { throw new Error('not json'); } });
  const adapter = { api: { host: 'https://x.es', list: { path: '/control_panel/settings/receipts', from: 'html', paging: 'none' } }, fields: { internalId: 'href', date: 'Date', total: 'Amount' }, schema: 'invoice@1' };
  const docs = await listInventory(adapter, { byPath: {}, merged: {} });
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['/receipts/A1.pdf', '/receipts/A2.pdf']); // id from the row's link
  assert.ok(docs.every((d) => d.date && d.total));
});

test('html list: extracts React data-props bootstrap JSON (hover.com style)', async () => {
  const props = { initialData: { path: '/', data: { receipts: [
    { id: 'r-1', date: '2026-01-02', total: '18.99', num: 'INV-1' },
    { id: 'r-2', date: '2026-02-02', total: '17.99', num: 'INV-2' },
  ] } }, feature_flags: [] };
  const html = `<div id='app' data-props='${JSON.stringify(props).replace(/"/g, '&quot;')}'></div>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://www.hover.com', list: { path: '/control_panel/settings/receipts', from: 'html', itemsPath: 'initialData.data.receipts', paging: 'none' } }, fields: { internalId: 'id', date: 'date', total: 'total', number: 'num' }, schema: 'invoice@1' };
  const docs = await listInventory(adapter, { byPath: {}, merged: {} });
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['r-1', 'r-2']);
  assert.ok(docs.every((d) => d.date && d.total));
});

test('offset paging advances by offsetStep until an empty page (Decathlon-style: 9/page)', async () => {
  const adapter = { api: { host: 'https://x.es', list: { path: '/orders', paging: 'offset', itemsPath: 'items', offsetParam: 'from', offsetStart: 0, offsetStep: 9 } }, fields: { internalId: 'id', date: 'd' }, schema: 'receipt@1' };
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(u);
    const from = Number(new URL(u).searchParams.get('from'));
    const ids = from < 18 ? [from, from + 1].map((n) => ({ id: 'R' + n, d: '2026-01-01' })) : []; // pages until offset 18 → empty
    return { ok: true, json: async () => ({ items: ids }), text: async () => '' };
  };
  const docs = await listInventory(adapter, { authorization: 'eyJ' });
  assert.equal(docs.length, 4);                                  // 2 + 2 + 0 → 4 docs (paginated past page 1!)
  assert.deepEqual(urls.map((u) => new URL(u).searchParams.get('from')), ['0', '9', '18']);
});

test('runtime resolves offset paging from offsetParam when `paging` is blank', async () => {
  const adapter = { api: { host: 'https://x.es', list: { path: '/o', paging: '', itemsPath: 'items', offsetParam: 'from', offsetStart: 0, offsetStep: 2 } }, fields: { internalId: 'id', date: 'd' }, schema: 'receipt@1' };
  globalThis.fetch = async (u) => { const from = Number(new URL(u).searchParams.get('from')); const ids = from < 4 ? [from, from + 1].map((n) => ({ id: 'R' + n, d: '2026-01-01' })) : []; return { ok: true, json: async () => ({ items: ids }) }; };
  const docs = await listInventory(adapter, { authorization: 'eyJ' });
  assert.equal(docs.length, 4); // paginated despite paging:'' (offsetParam drives it)
});

test('fetchDetail sends static detail.headers and templates the id in the query', async () => {
  const adapter = { api: { host: 'https://www.decathlon.es', detail: { path: '/web-engage/ajax/order?associationId={internalId}&orderManager=cube', headers: { 'dkt-ecom-origin': 'web-navigate-front', 'dkt-ecom-country': 'ES' } } }, fields: { internalId: 'associationId' }, schema: 'receipt@1' };
  let seen;
  globalThis.fetch = async (u, init) => { seen = { u, headers: init.headers, cred: init.credentials }; return { ok: true, text: async () => JSON.stringify({ associationId: 'UUID-1', total: 5 }) }; };
  const { via } = await fetchDetail(adapter, {}, 'UUID-1');
  assert.equal(via, 'json');
  assert.equal(seen.headers['dkt-ecom-origin'], 'web-navigate-front');
  assert.equal(seen.headers['dkt-ecom-country'], 'ES');
  assert.equal(seen.cred, 'include');                       // cookie session rides along
  assert.ok(seen.u.includes('associationId=UUID-1'), seen.u);
});

test('fetchDocument from:list returns the raw list item as JSON (no network)', async () => {
  const adapter = { api: { host: 'https://x.es', list: { path: '/l' }, detail: { from: 'list' } }, fields: { internalId: 'id' }, schema: 'receipt@1' };
  let called = false; globalThis.fetch = async () => { called = true; return { ok: true, text: async () => '' }; };
  const doc = { internalId: 'A', _raw: { id: 'A', total: 9, lines: [{ sku: 'x' }] } };
  const { blob, via } = await fetchDocument(adapter, {}, doc);
  assert.equal(via, 'list');
  assert.equal(called, false); // no request — the item is already in hand
  assert.deepEqual(JSON.parse(await blob.text()), { id: 'A', total: 9, lines: [{ sku: 'x' }] });
});

test('cursor paging follows nextPath and emits transaction records', async () => {
  stub([
    { transactions: [{ id: 't1', valueDate: '2026-03-01', amount: -12.5, concept: 'Coffee', merchant: { name: 'Bar' }, direction: 'debit', operationType: 'PURCHASE' }], paging: { nextCursor: 'c2' } },
    { transactions: [{ id: 't2', valueDate: '2026-03-02', amount: -99, concept: 'ATM', merchant: { name: 'ATM' }, direction: 'debit', operationType: 'WITHDRAWAL' }], paging: { nextCursor: null } },
  ]);
  const docs = await listInventory(bank, auth);
  assert.equal(docs.length, 2);
  const r = docs.find((d) => d.internalId === 't1').record;
  assert.equal(r.amount, -12.5);
  assert.equal(r.counterparty, 'Bar');
  assert.equal(r.direction, 'debit');
});

test('none paging + invoice schema coerces numbers and nests issuer', async () => {
  stub([{ invoices: [{ invoiceNumber: 'F-1', issueDate: '2026-01-15', amountDue: '45.60', supplierName: 'E', supplyAddress: 'X', invoiceType: 'ELECTRICITY', supplyType: 'ELECTRICITY' }] }]);
  const docs = await listInventory(energy, auth);
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0].record, { internalId: 'F-1', date: '2026-01-15', total: 45.6, currency: 'EUR', category: 'utility', issuer: { name: 'E', address: 'X' }, number: 'F-1', type: 'ELECTRICITY', source: undefined });
});

test('fetchPdf throws cheaply for a source with no PDF', async () => {
  const { fetchPdf } = await import('../src/runtime/inventory.js');
  await assert.rejects(() => fetchPdf(bank, auth, 't1'), /no PDF/);
});

test('documentExt prefers GET pdf, then json detail, then POST pdf', async () => {
  const { documentExt } = await import('../src/runtime/inventory.js');
  assert.equal(documentExt({ api: { pdf: { path: '/p/{internalId}' } } }), 'pdf');
  assert.equal(documentExt({ api: { detail: { path: '/d/{internalId}' } } }), 'json');
  assert.equal(documentExt({ api: { pdf: { path: '/p', method: 'POST' }, detail: { path: '/d' } } }), 'json');
  assert.equal(documentExt({ api: {} }), null);
});

test('fetchDetail GETs the JSON detail (via=json)', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  globalThis.fetch = async (u) => { assert.match(u, /\/orders\/ORD-8$/); return { ok: true, text: async () => '{"id":"ORD-8"}' }; };
  const adapter = { api: { host: 'https://api.shop.es', detail: { path: '/orders/{internalId}' } } };
  const { blob, via } = await fetchDetail(adapter, auth, 'ORD-8');
  assert.equal(via, 'json');
  assert.equal(blob.type, 'application/json');
  assert.equal(await blob.text(), '{"id":"ORD-8"}');
});

test('fetchDetail extracts embedded JSON from a server-rendered page (via=embedded)', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  const html = '<html><body><h1>Pedido</h1><script id="__NEXT_DATA__" type="application/json">{"order":{"id":"X","total":9}}</script></body></html>';
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://www.shop.es', detail: { path: '/account/orderTracking?transactionId={internalId}&type=store' } } };
  const { blob, via } = await fetchDetail(adapter, {}, 'X-UUID');
  assert.equal(via, 'embedded');
  assert.equal(JSON.parse(await blob.text()).order.id, 'X');
});

test('detail narrows the embedded app state to just the requested purchase', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  const state = { props: { pageProps: {
    orders: [{ id: 'A', total: 1 }, { id: 'B', total: 2 }],           // the WHOLE list (all purchases)
    order: { id: 'B', total: 2, lines: [{ sku: 'x' }], address: 'C/ Y' }, // the one being viewed
  } } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://x.es', detail: { path: '/o?id={internalId}' } } };
  const { blob } = await fetchDetail(adapter, {}, 'B');
  const data = JSON.parse(await blob.text());
  assert.equal(data.id, 'B');                 // only order B
  assert.ok(data.lines && data.address);      // the rich detail
  assert.ok(!('orders' in data));             // NOT the whole state with every purchase
});

test('fetchDetail parses an HTML table (via=table)', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  const html = '<table><tr><td>Total</td><td>9,90 €</td></tr><tr><td>Estado</td><td>Entregado</td></tr></table>';
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://www.shop.es', detail: { path: '/d/{internalId}' } } };
  const { blob, via } = await fetchDetail(adapter, {}, 'A');
  assert.equal(via, 'table');
  const data = JSON.parse(await blob.text());
  assert.equal(data.Total, '9,90 €');
  assert.equal(data.Estado, 'Entregado');
});

test('fetchDocument returns json + via for a detail source', async () => {
  const { fetchDocument } = await import('../src/runtime/inventory.js');
  globalThis.fetch = async () => ({ ok: true, text: async () => '{"x":1}' });
  const adapter = { api: { host: 'https://api.shop.es', detail: { path: '/o/{internalId}' } } };
  const doc = await fetchDocument(adapter, auth, 'A');
  assert.equal(doc.ext, 'json');
  assert.equal(doc.via, 'json');
  assert.equal(await doc.blob.text(), '{"x":1}');
});
