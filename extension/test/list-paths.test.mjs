// `paths` (array) support: an account list / item list assembled from SEVERAL endpoints, merged. Raisin keeps
// deposits in BOTH /dashboard/active and /dashboard/inactive — one stream lists both. Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listInventory, listGroups } from '../src/runtime/inventory.js';

test('groups.paths merges accounts from several endpoints', async () => {
  const net = async (url) => {
    const entries = url.includes("inactive") ? [{ id: "INACT-1" }] : [{ id: "ACT-1" }, { id: "ACT-2" }];
    return { ok: true, status: 200, json: async () => ({ entries }), text: async () => JSON.stringify({ entries }) };
  };
  const adapter = { id: 'x', api: { host: 'https://h.example', groups: { paths: ['/d/dashboard/active', '/d/dashboard/inactive'], itemsPath: 'entries', fields: { id: 'id' } } } };
  const groups = await listGroups(adapter, { byPath: {}, merged: {} }, net);
  assert.deepEqual(groups.map((g) => g.id).sort(), ['ACT-1', 'ACT-2', 'INACT-1'], 'accounts from both endpoints merged');
});

test('list.paths merges items from several endpoints (deposits: active + inactive)', async () => {
  const net = async (url) => {
    const items = url.includes("inactive") ? [{ id: "I-1", d: "2026-02-01" }] : [{ id: "A-1", d: "2026-01-01" }];
    return { ok: true, status: 200, json: async () => ({ items }), text: async () => JSON.stringify({ items }) };
  };
  const adapter = { id: 'x', schema: 'receipt@1', api: { host: 'https://h.example', list: { paths: ['/l/active', '/l/inactive'], paging: 'none', itemsPath: 'items' } }, fields: { internalId: 'id', date: 'd' } };
  const docs = await listInventory(adapter, { byPath: {}, merged: {} }, net, {});
  assert.deepEqual(docs.map((d) => d.internalId).sort(), ['A-1', 'I-1'], 'items from both endpoints merged');
});
