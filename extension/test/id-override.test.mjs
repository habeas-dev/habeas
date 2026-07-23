import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInventory } from '../src/runtime/inventory.js';

// list.idOverride gives card movements a STABLE natural key {date|amount|productId} + a per-IMPORT ordinal, so
// ING's churning-id pending charges dedupe across imports WITHOUT merging two genuinely-distinct charges that
// share (date, amount, productId) — those are told apart because they arrive TOGETHER in one import.
// All values SYNTHETIC. Scenario: two real €50.00 Google Pay charges on the same day.
const ADAPTER = {
  id: 'gp', service: 'gp', schema: 'transaction@1', keepRaw: true, currency: 'EUR',
  api: {
    host: 'https://x.test',
    list: {
      path: '/tx', itemsPath: 'transactions', paging: 'none',
      idOverride: { when: { field: 'status', present: true }, template: 'card|{date}|{amount}|{productId}' },
    },
  },
  fields: { internalId: 'uuid', date: 'date', amount: 'amount', description: 'merchant' },
};
const AUTH = { byPath: {}, merged: {} };
const netOf = (items) => async () => ({ ok: true, status: 200, json: async () => ({ transactions: items }), text: async () => JSON.stringify({ transactions: items }) });
const ids = (docs) => docs.map((d) => d.internalId).sort();

// a Google Pay CARD charge (has a `status`); `u` = the volatile transactionLocalUUID ING churns every import
const gp = (u, over = {}) => ({ uuid: u, date: '2026-07-20', amount: -50, productId: 'GPAY', merchant: 'GOOGLE PAY', status: { description: 'Pendiente de liquidar' }, ...over });
const KEY = 'card|2026-07-20|-50|GPAY';

test('two real €50 Google Pay charges in ONE import → two distinct records (ordinal 0,1)', async () => {
  const docs = await listInventory(ADAPTER, AUTH, netOf([gp('u1'), gp('u2')]));
  assert.equal(docs.length, 2);
  assert.deepEqual(ids(docs), [`${KEY}|0`, `${KEY}|1`]);
});

test('re-import of the SAME two (churned uuids) dedupes both — 0 new', async () => {
  const known = [`${KEY}|0`, `${KEY}|1`];
  const docs = await listInventory(ADAPTER, AUTH, netOf([gp('u3'), gp('u4')]), { knownIds: known });
  assert.equal(docs.length, 0);
});

test('a THIRD distinct €50 charge later → gets its own id (ordinal 2), the first two still dedupe', async () => {
  const known = [`${KEY}|0`, `${KEY}|1`];
  const docs = await listInventory(ADAPTER, AUTH, netOf([gp('u3'), gp('u4'), gp('u5')]), { knownIds: known });
  assert.deepEqual(ids(docs), [`${KEY}|2`]);
});

test('a single churning charge is stable across imports (always ordinal 0)', async () => {
  const one = await listInventory(ADAPTER, AUTH, netOf([gp('uA')]));
  assert.deepEqual(ids(one), [`${KEY}|0`]);
  const two = await listInventory(ADAPTER, AUTH, netOf([gp('uB')]), { knownIds: [`${KEY}|0`] }); // churned uuid, re-import
  assert.equal(two.length, 0); // deduped
});

test('pending → settled is the same charge (same key) → dedupes, not doubled', async () => {
  // the charge was stored while pending as KEY|0; now it settles (status "Liquidado") — still KEY|0 → deduped
  const settled = await listInventory(ADAPTER, AUTH, netOf([gp('uC', { status: { description: 'Liquidado' } })]), { knownIds: [`${KEY}|0`] });
  assert.equal(settled.length, 0);
});

test('account movements (no status) are NOT overridden — genuine same-day/amount repeats stay distinct', async () => {
  const acct = (u) => ({ uuid: u, date: '2026-07-17', amount: 18.4, merchant: 'TRANSFER' }); // no `status`
  const docs = await listInventory(ADAPTER, AUTH, netOf([acct('a1'), acct('a2')]));
  assert.deepEqual(ids(docs), ['a1', 'a2']); // kept apart by their stable UUID, never merged
});
