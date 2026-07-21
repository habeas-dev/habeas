// An UNGROUPED source (a flat list — e.g. Raisin deposits, where each deposit IS its own account) can still
// give each row an account name by mapping a `group` field directly. buildRecord uses it when there's no
// transient _group. Synthetic values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord } from '../src/sinks/format.js';

test('a mapped `group` field labels a row from an ungrouped source', () => {
  const d = { internalId: 'D1', date: '2024-03-22', total: 20236.31, currency: 'EUR', group: 'Depósito Banca Progetto', source: 'x', recordType: 'cash' };
  const r = buildRecord(d, { schema: 'investment@2', id: 'x' });
  assert.equal(r.group, 'Depósito Banca Progetto');
});

test('no group anywhere → the record stays byte-identical (no empty group key)', () => {
  const d = { internalId: 'R1', date: '2024-01-01', total: 9, currency: 'EUR', storeName: 'Shop', source: 'x' };
  const r = buildRecord(d, { schema: 'receipt@1', id: 'x' });
  assert.equal('group' in r, false, 'ungrouped record has no group key');
});
