import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftWarnings } from '../src/runtime/inferextras.js';

// Only 11 of the 24 published sources would draft with no hand editing, so a draft is a starting point,
// not a finished source. These are the things a draft can be missing that the user would otherwise only
// discover months later as silently missing history. Synthetic drafts throughout.

const base = () => ({
  id: 'demo', schema: 'transaction@1',
  api: { host: 'https://api.demo.test', list: { path: '/mov', itemsPath: 'movements', paging: 'cursor' } },
  fields: { internalId: 'id', date: 'fecha', amount: 'importe' },
});

test('a complete-looking draft warns about nothing', () => {
  const d = base();
  d.api.detail = { path: '/mov/{internalId}' };
  assert.deepEqual(draftWarnings(d, { count: 137 }), []);
});

test('an unpaginated list that stopped on a round number probably has more behind it', () => {
  const d = base();
  d.api.list.paging = 'none';
  const w = draftWarnings(d, { count: 50 });
  assert.ok(w.includes('warn_paging'), `expected a paging warning, got ${w}`);
});

test('an unpaginated list with an odd count looks like the whole thing', () => {
  const d = base();
  d.api.list.paging = 'none';
  assert.ok(!draftWarnings(d, { count: 137 }).includes('warn_paging'));
});

test('a date-filtered API with no range would keep asking for the day it was recorded', () => {
  const d = base();
  d.api.list.params = { fromDate: '2026-05-14' };
  assert.ok(draftWarnings(d, { count: 137 }).includes('warn_range'));
});

test('no per-document endpoint means records only — worth saying, not an error', () => {
  const d = base();                      // no api.pdf, no api.detail
  assert.ok(draftWarnings(d, { count: 137 }).includes('warn_nodocs'));
});

test('a missing date or amount is called out, since the rows would be unusable', () => {
  const noDate = base(); delete noDate.fields.date;
  assert.ok(draftWarnings(noDate, { count: 20 }).includes('warn_nodate'));
  const noAmount = base(); delete noAmount.fields.amount;
  assert.ok(draftWarnings(noAmount, { count: 20 }).includes('warn_noamount'));
});

test('a receipt source is checked on `total`, not `amount`', () => {
  const d = base();
  d.schema = 'receipt@1';
  d.fields = { internalId: 'id', date: 'fecha', total: 'importe' };
  d.api.pdf = { path: '/t/{internalId}.pdf' };
  assert.deepEqual(draftWarnings(d, { count: 137 }), []);
});

test('a cross-domain draft says so — it is the one that needs the user’s consent', () => {
  const d = base();
  d.api.detail = { path: '/x' };
  d.crossDomainHosts = ['files.other.test'];
  assert.ok(draftWarnings(d, { count: 137 }).includes('warn_crossdomain'));
});

test('a malformed draft yields nothing rather than throwing', () => {
  assert.deepEqual(draftWarnings(null, {}), []);
  assert.deepEqual(draftWarnings({}, {}), []);
});
