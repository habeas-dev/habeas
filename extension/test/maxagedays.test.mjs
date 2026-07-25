import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInventory } from '../src/runtime/inventory.js';

// maxAgeDays on an offset-paged, newest-first list must STOP paging once a whole page falls past the window —
// not fetch ever-older pages that get discarded (ING re-requesting card movements past its 90-day auth wall).
// Synthetic. 2 transactions per page: page 0 recent, page 1 all older than 90d → paging must stop (no page 2).
const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const ADAPTER = {
  id: 'bank', service: 'bank', schema: 'transaction@1', currency: 'EUR',
  api: { host: 'https://b.test', list: { path: '/tx', paging: 'offset', offsetParam: 'offset', offsetStep: 2, itemsPath: 'transactions', maxAgeDays: 90 } },
  fields: { internalId: 'id', date: 'date', amount: 'amount' },
};
const AUTH = { byPath: {}, merged: {} };
const PAGES = {
  0: [{ id: 'r1', date: iso(5), amount: -10 }, { id: 'r2', date: iso(40), amount: -20 }],   // within 90d
  2: [{ id: 'o1', date: iso(100), amount: -30 }, { id: 'o2', date: iso(120), amount: -40 }], // all older than 90d
  4: [{ id: 'x1', date: iso(200), amount: -50 }, { id: 'x2', date: iso(220), amount: -60 }], // must never be fetched
};

test('offset paging stops at the maxAgeDays boundary (no fetch past the window)', async () => {
  const seenOffsets = [];
  const net = async (url) => {
    const off = +(new URL(url).searchParams.get('offset') || 0);
    seenOffsets.push(off);
    return { ok: true, status: 200, json: async () => ({ transactions: PAGES[off] || [] }) };
  };
  const docs = await listInventory(ADAPTER, AUTH, net, {});
  assert.deepEqual(seenOffsets, [0, 2], 'fetched the recent page and the first past-window page, then stopped');
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['r1', 'r2'], 'only within-window movements surface (older ones discarded)');
});

test('a fully-recent list keeps paging until it naturally ends', async () => {
  const ALL_RECENT = { 0: [{ id: 'a', date: iso(1), amount: -1 }, { id: 'b', date: iso(2), amount: -2 }], 2: [] };
  const seen = [];
  const net = async (url) => { const off = +(new URL(url).searchParams.get('offset') || 0); seen.push(off); return { ok: true, status: 200, json: async () => ({ transactions: ALL_RECENT[off] || [] }) }; };
  const docs = await listInventory(ADAPTER, AUTH, net, {});
  assert.deepEqual(seen, [0, 2], 'no early stop; stops on the empty page');
  assert.equal(docs.length, 2);
});
