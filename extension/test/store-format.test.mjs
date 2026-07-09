// Canonical store — portable format merge/project/views (pure, no I/O). See docs/canonical-store.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySource, mergeItems, mergeSources, project, views } from '../src/lib/store/format.js';

const rec = (id, date, total, category) => ({ internalId: id, date, total, category });

test('mergeItems: adds items keyed by internalId, later timestamp wins (LWW)', () => {
  let s = emptySource({ source: 'amazon-es' });
  s = mergeItems(s, [{ internalId: 'A', record: rec('A', '2026-01-01', 10), at: '2026-07-01T00:00:00Z' }]);
  s = mergeItems(s, [{ internalId: 'B', record: rec('B', '2026-02-01', 20), at: '2026-07-01T00:00:00Z' }]);
  assert.deepEqual(Object.keys(s.items).sort(), ['A', 'B']);
  // a LATER capture updates the record; an OLDER one does not
  s = mergeItems(s, [{ internalId: 'A', record: rec('A', '2026-01-01', 99), at: '2026-07-02T00:00:00Z' }]);
  assert.equal(s.items.A.record.total, 99);
  s = mergeItems(s, [{ internalId: 'A', record: rec('A', '2026-01-01', 1), at: '2026-06-01T00:00:00Z' }]);
  assert.equal(s.items.A.record.total, 99); // stale write ignored
});

test('mergeItems: a later tombstone marks gone; a genuinely later re-capture revives it', () => {
  let s = mergeItems(emptySource(), [{ internalId: 'X', record: rec('X', '2026-01-01', 5), at: '2026-07-01T00:00:00Z' }]);
  s = mergeItems(s, [{ internalId: 'X', gone: true, goneReason: 'retention', goneAt: '2026-07-05T00:00:00Z', at: '2026-07-05T00:00:00Z' }]);
  assert.equal(s.items.X.gone, true);
  assert.equal(s.items.X.goneReason, 'retention');
  // an older capture must NOT un-tombstone
  s = mergeItems(s, [{ internalId: 'X', record: rec('X', '2026-01-01', 5), at: '2026-07-02T00:00:00Z' }]);
  assert.equal(s.items.X.gone, true);
  // a newer capture (item reappeared) revives it
  s = mergeItems(s, [{ internalId: 'X', record: rec('X', '2026-01-01', 5), at: '2026-07-09T00:00:00Z' }]);
  assert.ok(!s.items.X.gone);
});

test('project: live records only, minus delivered, minus not-accepted, newest first', () => {
  let s = emptySource();
  s = mergeItems(s, [
    { internalId: 'a', record: rec('a', '2026-01-01', 10, 'grocery'), at: 't1' },
    { internalId: 'b', record: rec('b', '2026-03-01', 20, 'fuel'), at: 't1' },
    { internalId: 'c', record: rec('c', '2026-02-01', 30, 'grocery'), at: 't1' },
    { internalId: 'd', gone: true, goneReason: 'rescan', goneAt: 't2', at: 't2' },
  ]);
  // all live, nothing delivered
  assert.deepEqual(project(s).map((r) => r.internalId), ['b', 'c', 'a']); // newest date first
  // 'b' already delivered to this sink
  assert.deepEqual(project(s, { delivered: { b: 1 } }).map((r) => r.internalId), ['c', 'a']);
  // typed consumer that only accepts grocery
  assert.deepEqual(project(s, { accepts: (r) => r.category === 'grocery' }).map((r) => r.internalId), ['c', 'a']);
});

test('views: pending/archived/missed = live/gone × ledger', () => {
  let s = mergeItems(emptySource(), [
    { internalId: 'p', record: rec('p'), at: 't' },                                   // live, undelivered → pending
    { internalId: 'q', record: rec('q'), at: 't' },                                   // live, delivered
    { internalId: 'g1', gone: true, goneReason: 'retention', goneAt: 't', at: 't' },  // gone, delivered → archived
    { internalId: 'g2', gone: true, goneReason: 'retention', goneAt: 't', at: 't' },  // gone, undelivered → missed
  ]);
  const v = views(s, { q: 1, g1: 1 });
  assert.deepEqual(v.pending, ['p']);
  assert.deepEqual(v.archived, ['g1']);
  assert.deepEqual(v.missed, ['g2']);
  assert.equal(v.live, 2); assert.equal(v.gone, 2);
});

test('mergeSources: union two stores by id without clobbering (for moving between backends)', () => {
  const a = mergeItems(emptySource(), [{ internalId: '1', record: rec('1', '2026-01-01', 5), at: 't1' }]);
  const b = mergeItems(emptySource(), [
    { internalId: '1', record: rec('1', '2026-01-01', 7), at: 't2' }, // newer → wins
    { internalId: '2', record: rec('2', '2026-02-01', 9), at: 't1' }, // new
  ]);
  const m = mergeSources(a, b);
  assert.deepEqual(Object.keys(m.items).sort(), ['1', '2']);
  assert.equal(m.items['1'].record.total, 7);
});
