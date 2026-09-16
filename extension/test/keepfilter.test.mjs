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

// match / excludeMatch (regex on the field) + `when` (scope the rule to some items, pass the rest through).
// This is how ING drops still-authorised (unconfirmed) CARD charges: a posted movement's operationId is
// "seq|batch" (e.g. "8|208"), an authorisation's is a plain number ("276215"); the authorisation churns a
// fresh id every sync and piles up as duplicates. Keep only operationIds with a "|", scoped to card
// movements (status present) so account movements (no status, maybe no operationId) are never touched.
// All values SYNTHETIC.
const ingItems = [
  { operationId: '8|208', status: { description: 'x' }, note: 'posted card' },
  { operationId: '276215', status: { description: 'x' }, note: 'authorised card (drop)' },
  { operationId: '813595', status: { description: 'x' }, note: 'authorised card (drop)' },
  { operationId: '1|208', status: { description: 'x' }, note: 'posted card' },
  { note: 'account movement — no status, no operationId (must pass)' },
  { operationId: 'ABC', note: 'account movement with a plain op but NO status (must pass)' },
];

test('match + when: keep only card movements whose operationId has a "|"; account movements untouched', () => {
  const kept = keepFilter(ingItems, { field: 'operationId', when: { field: 'status', present: true }, match: '\\|' });
  assert.deepEqual(kept.map((x) => x.note), [
    'posted card',
    'posted card',
    'account movement — no status, no operationId (must pass)',
    'account movement with a plain op but NO status (must pass)',
  ]);
});

test('excludeMatch + when: the inverse — drop card movements whose operationId is a plain number', () => {
  const kept = keepFilter(ingItems, { field: 'operationId', when: { field: 'status', present: true }, excludeMatch: '^\\d+$' });
  assert.deepEqual(kept.filter((x) => x.status).map((x) => x.operationId), ['8|208', '1|208']);
  assert.equal(kept.length, 4); // 2 posted card + 2 account movements
});

test('when scope with values: rule applies only to items whose scope field is in the list', () => {
  const kept = keepFilter(ingItems, { field: 'operationId', when: { field: 'status.description', values: ['x'] }, match: '\\|' });
  assert.equal(kept.length, 4); // same as present:true here
});

test('match without when applies to ALL items (a field-absent value becomes "" and fails a required match)', () => {
  const kept = keepFilter(ingItems, { field: 'operationId', match: '\\|' });
  assert.deepEqual(kept.map((x) => x.operationId), ['8|208', '1|208']); // everything else dropped, incl. account movements
});
