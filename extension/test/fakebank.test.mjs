import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBank, fakeBankSource, FAKE_ACCOUNTS, FAKE_BROKER_ACCOUNT } from './e2e/mock-bank.mjs';
import { validateAdapter } from '../src/adapters/validate.js';
import { outputsOf, resolveOutput } from '../src/lib/outputs.js';
import { listInventory } from '../src/runtime/inventory.js';
import { toRecords } from '../src/sinks/format.js';

// The fake bank stands in for a real service in end-to-end tests, so it has to be a source the real runtime
// accepts and lists exactly like a published one. This drives the runtime against the live mock over
// loopback (no browser) and checks the records Habeas builds from it, raw and canonical.

let bank, source;
const AUTH = { merged: { authorization: 'bearer eyJmYWtlYmFuaw.e2e.token' }, byPath: {}, ctx: {} };
// Page-context fetch stand-in: a real HTTP round trip to the mock, with the replayed headers.
const net = (url, init = {}) => fetch(url, { method: init.method || 'GET', headers: init.headers, body: init.body });
const delivered = (docs) => toRecords(docs, new Set(), { normalize: true }); // what a sink with `normalize` receives

before(async () => { bank = await startMockBank(); source = fakeBankSource(bank.port); });
after(() => bank.server.close());

test('fake bank source validates, with one output per stream', () => {
  const v = validateAdapter(source);
  assert.deepEqual(v.errors || [], [], JSON.stringify(v.errors));
  assert.deepEqual(outputsOf(source).map((o) => o.id), ['movements', 'portfolio']);
});

test('the API refuses a request without the captured session', async () => {
  const r = await fetch(`${bank.origin}/api/accounts`);
  assert.equal(r.status, 401);
});

test('movements: every account, every page, with value date and a running balance that adds up', async () => {
  const docs = await listInventory(resolveOutput(source, 'movements'), AUTH, net, {});
  const state = await (await fetch(`${bank.origin}/__control/state`)).json();
  const expected = Object.values(state.movements).reduce((a, b) => a + b, 0);
  assert.equal(docs.length, expected, 'all movements of all accounts (the payroll account needs three pages)');
  assert.equal(new Set(docs.map((d) => d.internalId)).size, docs.length, 'ids are unique');

  const recs = delivered(docs);
  for (const acc of FAKE_ACCOUNTS) {
    const mine = recs.filter((r) => r.id.startsWith(acc.id + '-')).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    assert.ok(mine.length > 0, acc.id + ' has movements');
    let bal = acc.opening;
    for (const r of mine) {
      bal = Math.round((bal + r.amount) * 100) / 100;
      assert.equal(r.balanceAfter, bal, `${r.id} balance`);
      assert.equal(r.valueDate, r.date);
      assert.equal(r.currency, 'EUR');
      assert.equal(r.direction, r.amount < 0 ? 'debit' : 'credit');
    }
  }
});

test('movements: the canonical account carries the IBAN, or a card\'s last4', async () => {
  const recs = delivered(await listInventory(resolveOutput(source, 'movements'), AUTH, net, {}));
  const current = recs.find((r) => r.id.startsWith('ACC-CURRENT-'));
  assert.equal(current.account.iban, 'ES9121000418450200051332');
  assert.equal(current.account.last4, '1332');
  const card = recs.find((r) => r.id.startsWith('CARD-4242-'));
  assert.equal(card.account.iban, undefined);
  assert.equal(card.account.last4, '4242');
  const payroll = recs.find((r) => r.description === 'SALARY ACME SOLUTIONS LTD');
  assert.equal(payroll.amount, 2150);
});

test('broker: trades and cash movements are built as investment@2 records', async () => {
  const docs = await listInventory(resolveOutput(source, 'portfolio'), AUTH, net, {});
  assert.equal(docs.length, 9);
  const recs = docs.map((d) => d.record);
  const buy = recs.find((r) => r.recordType === 'trade' && r.side === 'buy' && r.instrument && r.instrument.isin === 'IE00B4L5Y983');
  assert.ok(buy, 'a buy of IWDA, with recordType and instrument');
  assert.equal(buy.units, 20);
  assert.equal(buy.price, 98.45);
  assert.equal(buy.grossAmount, 1969);
  assert.equal(buy.commission, 1);
  assert.equal(buy.netAmount, -1970);
  assert.equal(buy.settlementAccount, FAKE_BROKER_ACCOUNT);
  const div = recs.find((r) => r.side === 'dividend');
  assert.equal(div.taxWithheld, 0.12);
  const sell = recs.find((r) => r.side === 'sell');
  assert.equal(sell.netAmount, Math.round((5 * 101.3 - 1 - 2.73) * 100) / 100);
  const interest = recs.find((r) => r.recordType === 'cash' && r.kind === 'interest');
  assert.ok(interest, 'interest as a cash record');
  assert.equal(interest.amount, 4.21);
  assert.equal(recs.filter((r) => r.recordType === 'cash').length, 4);
});

test('control API: an appended movement shows up on the next listing, with its balance', async () => {
  await fetch(`${bank.origin}/__control/movement`, { method: 'POST', body: JSON.stringify({ account: 'ACC-SAVINGS', date: '2026-10-31', amount: 10.5, concept: 'INTEREST PAYMENT' }) });
  try {
    const recs = delivered(await listInventory(resolveOutput(source, 'movements'), AUTH, net, {}));
    const added = recs.find((r) => r.id === 'ACC-SAVINGS-0004');
    assert.ok(added, 'new movement listed');
    assert.equal(added.balanceAfter, 5000 + 500 + 9.87 + 500 + 10.5);
  } finally {
    await fetch(`${bank.origin}/__control/reset`, { method: 'POST' });
  }
});
