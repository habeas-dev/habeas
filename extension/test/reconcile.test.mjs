import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBalanceContinuity } from '../src/lib/reconcile.js';

// Reported from production: eighteen months of Revolut transactions whose amounts summed to −10.253,24
// while the balance had actually moved by 7,56. Every record looked plausible, the import reported
// success, and the account was wrong by ten thousand euros. A statement is self-checking — each movement
// carries the balance it left behind — and nobody was checking it.

const mv = (date, amount, bal, extra = {}) => ({ date, amount, balanceAfter: bal, ...extra });

test('a consistent run adds up', () => {
  const r = checkBalanceContinuity([mv('2026-01-01', 100, 1100), mv('2026-01-02', -40, 1060), mv('2026-01-03', -60, 1000)]);
  assert.equal(r.ok, true, JSON.stringify(r.runs));
  assert.equal(r.gap, 0);
});

test('a missing movement is caught, and the gap is its amount', () => {
  // The balance jumps by 500 with no movement to explain it — exactly the Revolut shape.
  const r = checkBalanceContinuity([mv('2026-01-01', 100, 1100), mv('2026-01-03', -60, 1540)]);
  assert.equal(r.ok, false);
  assert.equal(Math.round(r.gap), 500);
});

test('an amount that arrived as zero is caught too', () => {
  // The other half of the same report: card payments delivered with amount 0. The balance knows.
  const r = checkBalanceContinuity([mv('2026-01-01', -20, 980), mv('2026-01-02', 0, 930)]);
  assert.equal(r.ok, false);
  assert.equal(Math.round(r.gap), -50);
});

test('currencies and pockets are checked apart, never summed together', () => {
  // A multi-currency account does not share one balance line. Summing across them would invent a
  // discrepancy out of arithmetic on unrelated numbers — and hide a real one behind it.
  const r = checkBalanceContinuity([
    mv('2026-01-01', 100, 1100, { currency: 'EUR' }), mv('2026-01-02', -100, 1000, { currency: 'EUR' }),
    mv('2026-01-01', 50, 250, { currency: 'USD' }), mv('2026-01-02', -50, 200, { currency: 'USD' }),
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.runs));
  assert.equal(r.runs.length, 2);
});

test('the FIRST movement cannot be checked, and the check must not pretend otherwise', () => {
  // A known limit, not an oversight. The opening balance is derived from the first movement
  // (balance - amount), so that movement is the one thing the arithmetic cannot contradict: a wrong
  // first amount simply shifts the assumed opening by the same figure. Everything after it is checked.
  // Detecting it would need an opening balance from outside the run, which the API does not give.
  const r = checkBalanceContinuity([mv('2026-01-01', 0, 100), mv('2026-01-02', 10, 110)]);
  assert.equal(r.ok, true, 'the first movement is unverifiable by construction');
  // …but the same wrong amount ANYWHERE else is caught, which is what makes the check worth running.
  const r2 = checkBalanceContinuity([mv('2026-01-01', 10, 110), mv('2026-01-02', 0, 100)]);
  assert.equal(r2.ok, false);
  assert.equal(Math.round(r2.gap), -10);
});

test('movements lacking a balance are ignored rather than guessed at', () => {
  const r = checkBalanceContinuity([mv('2026-01-01', 100, 1100), { date: '2026-01-02', amount: -40 }]);
  assert.equal(r.runs.length, 0, 'one usable movement is not an interval');
  assert.equal(r.ok, true);
});

test('records nested under .record are read too, since that is what a sink receives', () => {
  const r = checkBalanceContinuity([
    { record: { date: '2026-01-01', amount: 100, balanceAfter: 1100, currency: 'EUR' } },
    { record: { date: '2026-01-02', amount: -40, balanceAfter: 1060, currency: 'EUR' } },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.runs));
});

test('out-of-order input is sorted before checking', () => {
  const r = checkBalanceContinuity([mv('2026-01-03', -60, 1000), mv('2026-01-01', 100, 1100), mv('2026-01-02', -40, 1060)]);
  assert.equal(r.ok, true, JSON.stringify(r.runs));
});

// ---------------------------------------------------------------- the zero-amount guard

import { listInventory } from '../src/runtime/inventory.js';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

const ADP = {
  id: 'bank-x', name: 'Bank X', service: 'bankx', domain: 'bankx.test',
  match: ['https://bankx.test/*'], schema: 'transaction@1',
  auth: { mode: 'bearer', tokenMatch: '^Bearer eyJ' },
  api: { host: 'https://api.bankx.test', list: { path: '/tx', itemsPath: '$', paging: 'none' } },
  fields: { internalId: 'id', date: 'date', amount: 'amount', currency: 'currency' },
};

test('a movement whose amount resolved to zero is dropped, and counted', async () => {
  // The Revolut failure: card payments arrived with amount 0, which at the destination is not an error
  // but a real 0,00 entry — it imports cleanly, sits in the ledger, and throws the balance out by exactly
  // what went missing. Nothing reports anything. Losing it is strictly better, provided it is countable.
  const net = async () => okJson([
    { id: 'A', date: '2026-01-01', amount: 12.5, currency: 'EUR' },
    { id: 'B', date: '2026-01-02', amount: 0, currency: 'EUR' },
    { id: 'C', date: '2026-01-03', amount: -4, currency: 'EUR' },
  ]);
  const docs = await listInventory(ADP, { merged: {}, byPath: {}, ctx: {} }, net, {});
  // Order is the runtime's business, not this test's — only WHICH movements survive matters here.
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['A', 'C']);
  assert.equal(docs.stats && docs.stats.skippedNoAmount, 1, 'the drop must be counted, never silent');
});

test('an ABSENT amount is left alone — that is an adapter defect, not a row to delete', async () => {
  // Dropping these too would be a far larger policy than the evidence supports, and would quietly empty
  // a source whose mapping is merely wrong.
  const net = async () => okJson([{ id: 'A', date: '2026-01-01', currency: 'EUR' }]);
  const docs = await listInventory(ADP, { merged: {}, byPath: {}, ctx: {} }, net, {});
  assert.equal(docs.length, 1);
});

test('a receipt totalling zero is kept — a full refund is a real document', async () => {
  const receipts = { ...ADP, schema: 'receipt@1', fields: { internalId: 'id', date: 'date', total: 'amount' } };
  const net = async () => okJson([{ id: 'R', date: '2026-01-01', amount: 0 }]);
  const docs = await listInventory(receipts, { merged: {}, byPath: {}, ctx: {} }, net, {});
  assert.equal(docs.length, 1, 'the guard must apply only where the amount IS the record');
});

test('every collect() passes the counter — two call shapes were missed the first time', async () => {
  // The guard worked while the count stayed at zero, because two of the nine call sites had a different
  // argument shape and kept the old signature. A drop that is not counted is the silent failure this was
  // written to end, so the wiring is pinned rather than trusted.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/runtime/inventory.js'), 'utf8');
  const calls = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\bcollect\(/.test(l) && !/function collect\(/.test(l));
  assert.ok(calls.length >= 8, `expected the collect call sites, found ${calls.length}`);
  const bare = calls.filter(([, l]) => !/,\s*stats\)/.test(l)).map(([n]) => n);
  assert.deepEqual(bare, [], `collect() without the counter at line(s) ${bare.join(', ')}`);
});
