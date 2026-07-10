// The `page` pager stops at the first empty page — but year-partitioned lists (Leroy Merlin: pageParam
// "yearOffset") can have an EMPTY year in the middle (a year with no purchases, e.g. 2025). list.stopAfterEmpty
// lets it bridge N consecutive empty pages before stopping, so older years aren't cut off. Synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInventory } from '../src/runtime/inventory.js';

// page 0 → 2026 (data), 1 → 2025 (EMPTY gap), 2 → 2024 (data), 3 → 2023 (data), then empties.
const PAGES = {
  0: [{ id: 'a', date: '2026-03-01' }],
  1: [],
  2: [{ id: 'b', date: '2024-05-01' }],
  3: [{ id: 'c', date: '2023-02-01' }],
};
const mk = (stopAfterEmpty) => ({
  id: 'x', name: 'X', service: 'x', domain: 'shop.es', match: ['https://shop.es/*'],
  categories: ['diy'], schema: 'receipt@1', auth: { mode: 'cookie', replayHeaders: [] },
  api: { host: 'https://shop.es', list: { path: '/r', itemsPath: 'receipts', paging: 'page', pageParam: 'yearOffset', pageStart: 0, stopAfterEmpty } },
  fields: { internalId: 'id', date: 'date' },
});
const net = async (url) => { const y = +new URL(url).searchParams.get('yearOffset'); return { ok: true, status: 200, json: async () => ({ receipts: PAGES[y] || [] }) }; };

test('stopAfterEmpty bridges an empty year and keeps older ones', async () => {
  const docs = await listInventory(mk(3), { byPath: {}, merged: {} }, net, {});
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['a', 'b', 'c'], 'the 2025 gap did not cut off 2024/2023');
});

test('default (no stopAfterEmpty) stops at the first empty page — old behaviour preserved', async () => {
  const docs = await listInventory(mk(undefined), { byPath: {}, merged: {} }, net, {});
  assert.deepEqual(docs.map((d) => d.internalId), ['a'], 'stops at the empty 2025, missing older years');
});
