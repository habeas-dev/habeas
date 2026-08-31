// The archive in the destination has its own copy of the problem. Each source keeps a cumulative index
// there, and that index only ever GROWS — mergeRecords adds and overwrites by id, it never removes. So
// retiring a duplicate in the canonical store leaves the destination still listing both, and the user who
// looks at their Dropbox still sees everything twice.
//
// Cleaning it means REPLACING that index rather than merging into it, which is the one operation in this
// codebase that can lose data if it goes wrong. Hence the guards below, written before the code.
//
// All values SYNTHETIC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeRecords } from '../src/sinks/format.js';

const r = (id, over = {}) => ({ internalId: id, date: '2026-07-27', amount: -12.4, description: 'Panaderia', ...over });
const OLD = 'T0000|27 JUL|12,40 €|PANADERIA|0';
const NEW = 'T0000|2026-07-27|-12.4|panaderia|0';

test('the retired copy is removed and everything else is left exactly as it was', () => {
  const before = [r(OLD), r(NEW), r('untouched')];
  const out = purgeRecords(before, new Set([OLD]));
  assert.deepEqual(out.records.map((x) => x.internalId), [NEW, 'untouched']);
  assert.equal(out.removed, 1);
  assert.deepEqual(out.records[1], before[2], 'a record that stays is not rewritten');
});

test('nothing to remove means NO write at all', () => {
  // Rewriting an index for no reason is a needless risk against someone's archive, and on a cloud
  // destination a needless round trip per source on every start-up.
  const out = purgeRecords([r(NEW)], new Set([OLD]));
  assert.equal(out.removed, 0);
  assert.equal(out.changed, false, 'the caller must be able to skip the write');
});

test('an index is never emptied — that is a lost archive, not a cleanup', () => {
  // The guard that matters most. If the set of ids to retire somehow covered everything, the honest
  // outcome is to refuse: an empty index in the destination is indistinguishable from a wiped archive.
  const out = purgeRecords([r(OLD), r('another')], new Set([OLD, 'another']));
  assert.equal(out.changed, false, 'refuses to write an empty index');
  assert.equal(out.refused, 'would-empty');
});

test('a malformed or empty existing index is left alone', () => {
  assert.equal(purgeRecords([], new Set([OLD])).changed, false);
  assert.equal(purgeRecords(null, new Set([OLD])).changed, false);
  assert.equal(purgeRecords('not an array', new Set([OLD])).changed, false);
});

test('records with no id are preserved, not silently dropped', () => {
  // They cannot be matched against the retired set, so they are none of this operation's business.
  const out = purgeRecords([r(OLD), { date: '2026-01-01', amount: -1 }], new Set([OLD]));
  assert.equal(out.changed, true);
  assert.equal(out.records.length, 1, 'the unidentified record survives the purge');
});

test('it is idempotent — running it again changes nothing', () => {
  const once = purgeRecords([r(OLD), r(NEW)], new Set([OLD]));
  const twice = purgeRecords(once.records, new Set([OLD]));
  assert.equal(twice.changed, false);
});
