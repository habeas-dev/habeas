// Pure view computation behind the popup inventory table: filter by group/type and sort by column,
// while preserving each row's ORIGINAL index (the checkbox data-i → onSend selection mapping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryView, distinctBy } from '../src/lib/inventoryview.js';

const label = (d) => d._group || '';
const items = [
  { internalId: 'a', date: '2026-01-03', type: 'ticket', _group: 'Visa 1234' },
  { internalId: 'b', date: '2026-03-01', type: 'invoice', _group: 'Visa 1234' },
  { internalId: 'c', date: '2026-02-01', type: 'ticket', _group: 'Amex 9999' },
];

test('default view sorts by date, newest first, and preserves original indices', () => {
  const v = inventoryView(items, {}, label);
  assert.deepEqual(v.map((r) => r.d.internalId), ['b', 'c', 'a']);
  assert.deepEqual(v.map((r) => r.i), [1, 2, 0], 'each row keeps its index into the source array');
});

test('filter by group narrows to one account, indices still point at the source', () => {
  const v = inventoryView(items, { filterGroup: 'Visa 1234' }, label);
  assert.deepEqual(v.map((r) => r.d.internalId), ['b', 'a']);
  assert.deepEqual(v.map((r) => r.i), [1, 0]);
});

test('filter by type', () => {
  const v = inventoryView(items, { filterType: 'ticket' }, label);
  assert.deepEqual(v.map((r) => r.d.internalId).sort(), ['a', 'c']);
});

test('sort by group ascending, then by type', () => {
  assert.deepEqual(inventoryView(items, { sortKey: 'group', sortDir: 1 }, label).map((r) => r.d._group),
    ['Amex 9999', 'Visa 1234', 'Visa 1234']);
  assert.deepEqual(inventoryView(items, { sortKey: 'type', sortDir: 1 }, label).map((r) => r.d.type),
    ['invoice', 'ticket', 'ticket']);
});

test('sort direction flips', () => {
  assert.deepEqual(inventoryView(items, { sortKey: 'type', sortDir: -1 }, label).map((r) => r.d.type),
    ['ticket', 'ticket', 'invoice']);
});

test('filter + sort compose', () => {
  const v = inventoryView(items, { filterGroup: 'Visa 1234', sortKey: 'type', sortDir: 1 }, label);
  assert.deepEqual(v.map((r) => r.d.type), ['invoice', 'ticket']);
});

test('distinctBy returns sorted unique non-empty string values', () => {
  assert.deepEqual(distinctBy(items, label), ['Amex 9999', 'Visa 1234']);
  assert.deepEqual(distinctBy(items, (d) => d.type), ['invoice', 'ticket']);
  assert.deepEqual(distinctBy([{ type: '' }, { type: null }, {}], (d) => d.type), [], 'empties dropped');
});
