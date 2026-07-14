import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory, listGroups } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';
import { buildRecord } from '../src/sinks/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = JSON.parse(readFileSync(join(here, '../../sources-repo/sources/ing-es.json'), 'utf8'));

// Synthetic, ING-shaped responses (no real data). Two accounts via /position-keeping (one with the IBAN
// buried in a typed identifiers[] — exercises get()'s array selector), plus a third product with NO uuid
// (must be skippable). Transactions come from /v2/products/{uuid}/transactions with offset paging.
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
  'acc-2': [
    { transactionLocalUUID: 't-a2-1', transactionDate: iso(5), amount: 3.21, concept: 'Interés', description: 'Intereses a tu favor', transactionCode: 'INT' },
  ],
};
const auth = { merged: { authorization: 'Bearer eyJx', 'x-ing-extendedsessioncontext': 'eyJy' }, byPath: {}, ctx: {} };
const net = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/position-keeping') return { ok: true, status: 200, json: async () => POSITION };
  const m = u.pathname.match(/^\/v2\/products\/([^/]+)\/transactions$/);
  if (m) { const off = +(u.searchParams.get('offset') || 0); const arr = TX[m[1]] || []; return { ok: true, status: 200, json: async () => ({ transactions: off === 0 ? arr : [] }) }; }
  return { ok: false, status: 404, json: async () => ({}) };
};

test('ING adapter validates', () => { const v = validateAdapter(SRC); assert.ok(v.ok, JSON.stringify(v)); });

test('ING enumerates accounts with IBAN pulled from typed identifiers[]', async () => {
  const groups = await listGroups(SRC, auth, net);
  const nomina = groups.find((g) => g.id === 'acc-1');
  assert.equal(nomina.name, 'Cuenta NÓMINA');
  assert.equal(nomina.iban, 'ES1111111111111111111111'); // get('identifiers[type=PRODUCT_NUMBER].value')
  assert.equal(groups.find((g) => g.id === 'acc-2').iban, 'ES2222222222222222222222');
});

test('ING lists transactions across accounts; account allow-list filters', async () => {
  const all = await listInventory(SRC, auth, net, {});
  assert.equal(all.length, 3);
  const one = await listInventory(SRC, auth, net, { groups: ['acc-1'] }); // persisted filter → only this account
  assert.equal(one.length, 2);
  assert.ok(one.every((d) => d.internalId.startsWith('t-a1')));
});

test('ING normalized record: signed amount, EUR, direction, group label', async () => {
  const recs = await listInventory(SRC, auth, net, { groups: ['acc-1'] });
  const rec = buildRecord(recs.find((d) => d.internalId === 't-a1-1'), SRC);
  assert.equal(rec.amount, -20);
  assert.equal(rec.currency, 'EUR');
  assert.equal(rec.direction, 'debit');
  assert.equal(rec.type, 'PURCH');
  assert.match(rec.group, /Cuenta NÓMINA/);
});
