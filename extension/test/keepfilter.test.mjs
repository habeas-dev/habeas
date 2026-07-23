// keepFilter routes list/group items by value, field presence, or id prefix. The prefix case is how Raisin
// splits one deposits dashboard into flexible savings (OMA_…) vs fixed deposits (FDA_…) — a split the replay
// harness can't check because captured ids are redacted, so it's unit-tested here. All values SYNTHETIC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepFilter } from '../src/runtime/inventory.js';

const items = [
  { account: { id: 'OMA_100_000_000_001' }, kind: 'flex' },
  { account: { id: 'FDA_200_000_000_002' }, kind: 'fixed', maturity: '2027-01-01' },
  { account: { id: 'OMA_100_000_000_003' }, kind: 'flex' },
  { account: { id: 'FDA_200_000_000_004' }, kind: 'fixed', maturity: '2028-06-01' },
  { account: {}, kind: 'broken' }, // malformed: no id
];

test('prefix: split OMA (flexible) vs FDA (fixed) on a dotted id path', () => {
  const oma = keepFilter(items, { field: 'account.id', prefix: 'OMA_' });
  const fda = keepFilter(items, { field: 'account.id', prefix: 'FDA_' });
  assert.deepEqual(oma.map((x) => x.account.id), ['OMA_100_000_000_001', 'OMA_100_000_000_003']);
  assert.deepEqual(fda.map((x) => x.account.id), ['FDA_200_000_000_002', 'FDA_200_000_000_004']);
  // the malformed (no id) entry is in neither
  assert.equal(oma.length + fda.length, 4);
});

test('prefix accepts an array of prefixes', () => {
  const both = keepFilter(items, { field: 'account.id', prefix: ['OMA_', 'FDA_'] });
  assert.equal(both.length, 4); // everything with an id; the broken one dropped
});

test('present: keep by whether a field exists', () => {
  assert.equal(keepFilter(items, { field: 'account.id', present: true }).length, 4);
  assert.equal(keepFilter(items, { field: 'maturity', present: true }).length, 2);
  assert.equal(keepFilter(items, { field: 'maturity', present: false }).length, 3);
});

test('values + no-op: exact match, and no keep returns everything', () => {
  assert.equal(keepFilter(items, { field: 'kind', values: ['flex'] }).length, 2);
  assert.equal(keepFilter(items, null).length, 5);
  assert.equal(keepFilter(items, { values: ['flex'] }).length, 5); // no field → no-op
});

test('exclude: drop matching values but KEEP items where the field is absent (ING pending charges)', () => {
  // ING re-lists a still-PENDING card charge with a fresh id every sync → pile-up; exclude drops them while
  // leaving settled + account movements (which have no status field) untouched.
  const kept = keepFilter(items, { field: 'kind', exclude: ['fixed', 'broken'] });
  assert.deepEqual(kept.map((x) => x.kind), ['flex', 'flex']);
  const byMat = keepFilter(items, { field: 'maturity', exclude: ['2027-01-01'] });
  assert.equal(byMat.length, 4); // the one 2027 item dropped; the other fixed + all field-absent items kept
});
