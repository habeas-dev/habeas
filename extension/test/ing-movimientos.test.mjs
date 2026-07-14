import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, listGroups, fetchArtifact, artifactKinds } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { buildRecord } from '../src/sinks/format.js';
import { resolveOutput } from '../src/lib/outputs.js';

const here = dirname(fileURLToPath(import.meta.url));
const FULL = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/ing-es.json'), 'utf8'));
const MOV = resolveOutput(FULL, 'movimientos');

// Synthetic, ING-shaped responses (no real data). /position-keeping has two accounts (the IBAN buried in a
// typed identifiers[] → exercises get()'s array selector) plus a product with NO uuid (must be skippable).
const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const POSITION = {
  products: [
    { uuid: 'acc-1', type: 'CURRENT_ACCOUNT', commercialName: 'Cuenta NÓMINA', denominationCurrency: 'EUR',
      identifiers: [{ type: 'UUID', value: 'acc-1' }, { type: 'PRODUCT_NUMBER', value: 'ES1111111111111111111111' }] },
    { uuid: 'acc-2', type: 'SAVINGS_ACCOUNT', commercialName: 'Cuenta NARANJA', denominationCurrency: 'EUR',
      identifiers: [{ type: 'PRODUCT_NUMBER', value: 'ES2222222222222222222222' }, { type: 'UUID', value: 'acc-2' }] },
    { type: 'DEBIT_CARD', commercialName: 'Tarjeta', identifiers: [{ type: 'PRODUCT_NUMBER', value: '4111111111111111' }] },
  ],
};
const TX = {
  'acc-1': [
    { transactionLocalUUID: 't-a1-1', transactionDate: iso(3), amount: -20, concept: 'Compra', description: 'Compra super', transactionCode: 'PURCH' },
    { transactionLocalUUID: 't-a1-2', transactionDate: iso(10), amount: 1500, concept: 'Nómina', description: 'Nomina recibida', transactionCode: 'PAYROLL' },
  ],
  'acc-2': [{ transactionLocalUUID: 't-a2-1', transactionDate: iso(5), amount: 3.21, concept: 'Interés', description: 'Intereses', transactionCode: 'INT' }],
};
const auth = { merged: { authorization: 'Bearer eyJx', 'x-ing-extendedsessioncontext': 'eyJy' }, byPath: {}, ctx: {} };
const net = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/position-keeping') return { ok: true, status: 200, json: async () => POSITION };
  const m = u.pathname.match(/^\/v2\/products\/([^/]+)\/transactions$/);
  if (m) { const off = +(u.searchParams.get('offset') || 0); return { ok: true, status: 200, json: async () => ({ transactions: off === 0 ? (TX[m[1]] || []) : [] }) }; }
  return { ok: false, status: 404, json: async () => ({}) };
};

test('ING adapter validates', () => { const v = validateAdapter(FULL); assert.ok(v.ok, JSON.stringify(v)); });

test('ING enumerates accounts with IBAN from typed identifiers[]', async () => {
  const groups = await listGroups(MOV, auth, net);
  assert.equal(groups.find((g) => g.id === 'acc-1').iban, 'ES1111111111111111111111');
  assert.equal(groups.find((g) => g.id === 'acc-2').iban, 'ES2222222222222222222222');
});

test('ING movimientos: lists transactions; account allow-list filters', async () => {
  assert.equal((await listInventory(MOV, auth, net, {})).length, 3);
  const one = await listInventory(MOV, auth, net, { groups: ['acc-1'] });
  assert.equal(one.length, 2);
  const rec = buildRecord(one.find((d) => d.internalId === 't-a1-1'), MOV);
  assert.equal(rec.amount, -20); assert.equal(rec.currency, 'EUR'); assert.equal(rec.direction, 'debit');
});

// Capture the document URL the runtime would fetch (per synthetic item), without downloading anything.
async function docUrl(eff, doc) {
  let url = null;
  const capture = async (u) => { url = String(u); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']), text: async () => '', headers: { get: () => 'application/pdf' } }; };
  await fetchArtifact(eff, auth, doc, capture, null, artifactKinds(eff, doc)[0].kind);
  return url;
}

test('ING informe: one PER-ACCOUNT PER-MONTH report; PDF + XLS URLs resolve', async () => {
  const pdf = resolveOutput(FULL, 'informe/pdf');
  const docs = await listInventory(pdf, auth, net, { groups: ['acc-1'] }); // synthetic group-months
  assert.ok(docs.length >= 1);
  assert.ok(docs.every((d) => d.internalId.startsWith('acc-1-')));
  const u = await docUrl(pdf, docs[0]);
  assert.match(u, /\/v2\/products\/acc-1\/transactions\/report\?/);
  assert.match(u, /reportType=pdf/);
  assert.match(u, /fromDate=\d{4}-\d{2}-\d{2}&toDate=\d{4}-\d{2}-\d{2}/); // window filled → no leftover {tokens}
  const xls = resolveOutput(FULL, 'informe/excel');
  const ux = await docUrl(xls, (await listInventory(xls, auth, net, { groups: ['acc-1'] }))[0]);
  assert.match(ux, /reportType=xls/);
});

test('ING extracto-mensual: one PER-MONTH integrated statement; PDF URL on the app host', async () => {
  const eff = resolveOutput(FULL, 'extracto-mensual');
  const docs = await listInventory(eff, auth, net, {}); // synthetic months, NOT grouped
  assert.ok(docs.length >= 1 && docs.length <= 5); // ~3-4 months in a 90-day window
  assert.match(docs[0].internalId, /^\d{4}-\d{2}$/);
  const u = await docUrl(eff, docs[0]);
  assert.match(u, /^https:\/\/ing\.ingdirect\.es\/genoma_api\/rest\/products\/statement\?year=\d{4}&month=\d{1,2}$/);
});
