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

test('a group field can be a TEMPLATE (readable account name), not just a plain path', async () => {
  const net = async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ entries: [{ id: 'OMA_1', product: { deposit_taking_bank: { name: 'Nordax Bank AB publ' } } }] }) });
  const adapter = { id: 'x', api: { host: 'https://h.example', groups: { path: '/g', itemsPath: 'entries', fields: { id: 'id', name: 'Cuenta {product.deposit_taking_bank.name}' } } } };
  const groups = await listGroups(adapter, { byPath: {}, merged: {} }, net);
  assert.equal(groups[0].id, 'OMA_1');
  assert.equal(groups[0].name, 'Cuenta Nordax Bank AB publ', 'the group name template resolved (was showing the raw id)');
});

test('{i18n:key} in a group field translates the word by locale (multi-market)', async () => {
  const net = async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ entries: [{ id: 'D1', bank: 'Acme' }] }) });
  const adapter = { id: 'x', i18n: { deposit: { en: 'Deposit', es: 'Depósito', de: 'Festgeld' } }, api: { host: 'https://h.example', groups: { path: '/g', itemsPath: 'entries', fields: { id: 'id', name: '{i18n:deposit} {bank}' } } } };
  const groups = await listGroups(adapter, { byPath: {}, merged: {} }, net);
  // The test env's UI locale decides which word; assert it's one of the dict values + the interpolated field.
  assert.match(groups[0].name, /^(Deposit|Depósito|Festgeld) Acme$/, 'the {i18n:deposit} word resolved and the field interpolated');
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
