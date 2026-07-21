// Two runtime fixes surfaced by Raisin (a cross-domain bank on api2.weltsparen.de):
//   1. list PARAMS must resolve {ctx.*} — a captured id (customerId) belongs in a query filter, not just the
//      path. Without it the literal `customer_id={ctx.customer_id}` was sent and the dbff/dbs upstream 403'd.
//   2. fetchPdf must append `pdf.params` to the document URL — Raisin's dds document needs `?preview=true`.
// All values synthetic; the net mock just captures the URL the runtime builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInventory, fetchPdf } from '../src/runtime/inventory.js';

test('list params resolve {ctx.*}: a captured customerId reaches the query, not the literal placeholder', async () => {
  let seen = '';
  const net = async (url) => {
    seen = String(url);
    const body = { entries: [{ id: 'DEP-1', amount: 12.5 }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  const adapter = {
    id: 'd', name: 'D', service: 'd', domain: 'bank.example', match: ['https://bank.example/*'],
    categories: ['banking'], schema: 'transaction@1',
    auth: { mode: 'bearer', replayHeaders: ['authorization'], context: [{ name: 'customer_id', from: 'url', match: 'customer_id=(C_[0-9]+)' }] },
    api: { host: 'https://bank.example', list: { path: '/deposits/dashboard/active', paging: 'none', itemsPath: 'entries', params: { customer_id: '{ctx.customer_id}', locale: 'es-ES' } } },
    fields: { internalId: 'id', amount: 'amount' },
  };
  const auth = { byPath: {}, merged: { authorization: 'Bearer x' }, ctx: { customer_id: 'C_9' } };
  const docs = await listInventory(adapter, auth, net, {});
  assert.match(seen, /customer_id=C_9/, '{ctx.customer_id} resolved into the query');
  assert.doesNotMatch(seen, /\{ctx/, 'no literal {ctx.*} left in the URL');
  assert.equal(docs.length, 1);
});

test('fetchPdf appends pdf.params to the document URL (?preview=true)', async () => {
  let seen = '';
  const net = async (url) => {
    seen = String(url);
    return { ok: true, status: 200, blob: async () => new Blob(['%PDF-']), arrayBuffer: async () => new ArrayBuffer(4), text: async () => '', json: async () => ({}), headers: { get: () => 'application/pdf' } };
  };
  const adapter = {
    id: 'x', name: 'X', service: 'x', domain: 'd.example', match: ['https://d.example/*'],
    categories: ['other'], schema: 'invoice@1',
    auth: { mode: 'bearer', replayHeaders: ['authorization'] },
    api: { host: 'https://d.example', list: { path: '/l', paging: 'none' }, pdf: { path: '/docs/{internalId}', params: { preview: 'true' } } },
  };
  const auth = { byPath: {}, merged: { authorization: 'Bearer x' }, ctx: {} };
  await fetchPdf(adapter, auth, { internalId: 'DOC1', _raw: { id: 'DOC1' } }, net);
  assert.match(seen, /\/docs\/DOC1\?preview=true/, 'pdf.params appended to the document fetch');
});
