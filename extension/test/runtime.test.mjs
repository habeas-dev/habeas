import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import carrefour from '../src/adapters/carrefour-es.js';
import mart from './fixtures/examplemart-es.js';
import bank from './fixtures/examplebank-es.js';
import energy from './fixtures/exampleenergy-es.js';
import { listInventory } from '../src/runtime/inventory.js';

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
  assert.deepEqual(docs[0].record, { externalId: 'P1', date: '2026-01-02', total: 12.34, currency: 'EUR', category: 'grocery', store: { name: 'S', address: 'A' }, source: undefined, type: 'HYPERMARKET' });
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

test('cursor paging follows nextPath and emits transaction records', async () => {
  stub([
    { transactions: [{ id: 't1', valueDate: '2026-03-01', amount: -12.5, concept: 'Coffee', merchant: { name: 'Bar' }, direction: 'debit', operationType: 'PURCHASE' }], paging: { nextCursor: 'c2' } },
    { transactions: [{ id: 't2', valueDate: '2026-03-02', amount: -99, concept: 'ATM', merchant: { name: 'ATM' }, direction: 'debit', operationType: 'WITHDRAWAL' }], paging: { nextCursor: null } },
  ]);
  const docs = await listInventory(bank, auth);
  assert.equal(docs.length, 2);
  const r = docs.find((d) => d.externalId === 't1').record;
  assert.equal(r.amount, -12.5);
  assert.equal(r.counterparty, 'Bar');
  assert.equal(r.direction, 'debit');
});

test('none paging + invoice schema coerces numbers and nests issuer', async () => {
  stub([{ invoices: [{ invoiceNumber: 'F-1', issueDate: '2026-01-15', amountDue: '45.60', supplierName: 'E', supplyAddress: 'X', invoiceType: 'ELECTRICITY', supplyType: 'ELECTRICITY' }] }]);
  const docs = await listInventory(energy, auth);
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0].record, { externalId: 'F-1', date: '2026-01-15', total: 45.6, currency: 'EUR', category: 'utility', issuer: { name: 'E', address: 'X' }, number: 'F-1', type: 'ELECTRICITY', source: undefined });
});

test('fetchPdf throws cheaply for a source with no PDF', async () => {
  const { fetchPdf } = await import('../src/runtime/inventory.js');
  await assert.rejects(() => fetchPdf(bank, auth, 't1'), /no PDF/);
});

test('documentExt prefers GET pdf, then json detail, then POST pdf', async () => {
  const { documentExt } = await import('../src/runtime/inventory.js');
  assert.equal(documentExt({ api: { pdf: { path: '/p/{externalId}' } } }), 'pdf');
  assert.equal(documentExt({ api: { detail: { path: '/d/{externalId}' } } }), 'json');
  assert.equal(documentExt({ api: { pdf: { path: '/p', method: 'POST' }, detail: { path: '/d' } } }), 'json');
  assert.equal(documentExt({ api: {} }), null);
});

test('fetchDetail GETs the JSON detail (via=json)', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  globalThis.fetch = async (u) => { assert.match(u, /\/orders\/ORD-8$/); return { ok: true, text: async () => '{"id":"ORD-8"}' }; };
  const adapter = { api: { host: 'https://api.shop.es', detail: { path: '/orders/{externalId}' } } };
  const { blob, via } = await fetchDetail(adapter, auth, 'ORD-8');
  assert.equal(via, 'json');
  assert.equal(blob.type, 'application/json');
  assert.equal(await blob.text(), '{"id":"ORD-8"}');
});

test('fetchDetail extracts embedded JSON from a server-rendered page (via=embedded)', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  const html = '<html><body><h1>Pedido</h1><script id="__NEXT_DATA__" type="application/json">{"order":{"id":"X","total":9}}</script></body></html>';
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://www.shop.es', detail: { path: '/account/orderTracking?transactionId={externalId}&type=store' } } };
  const { blob, via } = await fetchDetail(adapter, {}, 'X-UUID');
  assert.equal(via, 'embedded');
  assert.equal(JSON.parse(await blob.text()).order.id, 'X');
});

test('fetchDetail parses an HTML table (via=table)', async () => {
  const { fetchDetail } = await import('../src/runtime/inventory.js');
  const html = '<table><tr><td>Total</td><td>9,90 €</td></tr><tr><td>Estado</td><td>Entregado</td></tr></table>';
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const adapter = { api: { host: 'https://www.shop.es', detail: { path: '/d/{externalId}' } } };
  const { blob, via } = await fetchDetail(adapter, {}, 'A');
  assert.equal(via, 'table');
  const data = JSON.parse(await blob.text());
  assert.equal(data.Total, '9,90 €');
  assert.equal(data.Estado, 'Entregado');
});

test('fetchDocument returns json + via for a detail source', async () => {
  const { fetchDocument } = await import('../src/runtime/inventory.js');
  globalThis.fetch = async () => ({ ok: true, text: async () => '{"x":1}' });
  const adapter = { api: { host: 'https://api.shop.es', detail: { path: '/o/{externalId}' } } };
  const doc = await fetchDocument(adapter, auth, 'A');
  assert.equal(doc.ext, 'json');
  assert.equal(doc.via, 'json');
  assert.equal(await doc.blob.text(), '{"x":1}');
});
