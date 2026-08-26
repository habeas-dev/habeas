import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listInventory } from '../src/runtime/inventory.js';
import { resolveOutput } from '../src/lib/outputs.js';

// A field maps to ONE source path, which is right until the service reports the same quantity under two
// names — one authoritative, one that is merely usually equal. Revolut is the case that forced this:
// `amount` is the amount converted at the interbank rate, `amountWithCharges` is what actually left the
// account. They agree whenever nothing was charged, so `amount` looks correct almost always and is wrong
// exactly when a fee applied. Declaring the authoritative path FIRST and the other as a fallback says
// "prefer this, accept that" without inventing a rule about when each applies.
//
// All values below are invented. Nothing here comes from a real capture.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
const AUTH = { merged: {}, byPath: {}, ctx: {} };

const REVOLUT = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/revolut.json'), 'utf8'));
const ADP = resolveOutput(REVOLUT, 'transactions');
const feed = (items) => async (url) => (String(url).includes('/wallet')
  ? ok({ pockets: [{ id: 'p1', currency: 'EUR', type: 'CURRENT' }] })
  : ok(items));

// Charged 45,00 after a 0,45 fee on a 44,55 conversion. `amount` alone would under-report by the fee.
const CHARGED = {
  id: 'F1', startedDate: '2025-03-04', currency: 'EUR', state: 'COMPLETED', type: 'CARD_PAYMENT',
  description: 'Bookshop', amount: -4455, amountWithCharges: -4500, fee: 45, balance: 155000,
};
// No fee: the two agree, and the record must be unaffected by the fallback.
const PLAIN = {
  id: 'F2', startedDate: '2025-03-05', currency: 'EUR', state: 'COMPLETED', type: 'CARD_PAYMENT',
  description: 'Bakery', amount: -320, amountWithCharges: -320, fee: 0, balance: 154680,
};
// The authoritative field absent altogether: fall back rather than emit a movement with no amount.
const LEGACY = {
  id: 'F3', startedDate: '2025-03-06', currency: 'EUR', state: 'COMPLETED', type: 'CARD_PAYMENT',
  description: 'Newsagent', amount: -180, balance: 154500,
};

test('a movement reports what actually left the account, not the pre-fee conversion', async () => {
  const docs = await listInventory(ADP, AUTH, feed([CHARGED, PLAIN, LEGACY]), {});
  const by = Object.fromEntries(docs.map((d) => [d.internalId, d]));
  assert.equal(by.F1.amount, -45, 'the fee was dropped from the charged amount');
  assert.equal(by.F2.amount, -3.2, 'a fee-free movement changed');
  assert.equal(by.F3.amount, -1.8, 'no fallback when the authoritative field is absent');
});

test('a fallback path is only consulted when the one before it resolves to nothing', async () => {
  const adp = { ...ADP, fields: { ...ADP.fields, description: ['nonexistent.path', 'description'] } };
  const [doc] = await listInventory(adp, AUTH, feed([PLAIN]), {});
  assert.equal(doc.description, 'Bakery');
});

test('the minor-unit scaling still follows the movement currency, not a hardcoded 100', async () => {
  // JPY has no minor unit, so the charged amount must arrive unscaled. Dividing by 100 by hand — the
  // obvious way to write this fix — would silently turn 4500 yen into 45.
  const yen = { ...CHARGED, id: 'F4', currency: 'JPY' };
  const [doc] = await listInventory(ADP, AUTH, feed([yen]), {});
  assert.equal(doc.amount, -4500);
});
