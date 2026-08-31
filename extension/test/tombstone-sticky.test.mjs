// Retiring a superseded duplicate has to STICK. Entries merge last-write-wins by timestamp, and the old
// copies also live on in the manifest already delivered to the destination — which is additive and is read
// back by "recover data from destination". Read back with a fresh timestamp, an old copy would beat its own
// tombstone and the duplicates would return, so the cleanup would undo itself the next time anyone asked
// for a recovery, or the moment a second machine that has not migrated yet syncs its view.
//
// A `superseded` tombstone is a permanent judgement — that identity is one the source can never produce
// again — so it outranks any later write. Ordinary tombstones keep the old behaviour: a document that was
// gone and genuinely comes back is allowed back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeItems, mergeSources } from '../src/lib/store/format.js';

const rec = { date: '2026-07-27', amount: -12.4, description: 'Panaderia La Espiga' };
const OLD = 'T0000|27 JUL|12,40 €|PANADERIA LA ESPIGA|0';
const stored = (extra) => ({ items: { [OLD]: { record: rec, at: '2026-08-31T10:00:00.000Z', ...extra } }, meta: {} });

test('a superseded copy read back from the manifest does not return', () => {
  const s = stored({ gone: true, goneReason: 'superseded', goneAt: '2026-08-31T10:00:00.000Z' });
  mergeItems(s, [{ internalId: OLD, record: rec, at: '2026-09-01T09:00:00.000Z' }]); // later write wins normally
  assert.equal(s.items[OLD].gone, true, 'the retired copy must stay retired');
  assert.equal(s.items[OLD].goneReason, 'superseded');
});

test('nor when a whole store view from another machine is merged in', () => {
  const s = stored({ gone: true, goneReason: 'superseded' });
  mergeSources(s, { meta: {}, items: { [OLD]: { record: rec, at: '2026-09-02T09:00:00.000Z' } } });
  assert.equal(s.items[OLD].gone, true, 'a device that has not migrated must not undo the cleanup');
});

test('an ORDINARY tombstone still lets a document come back', () => {
  // A document that vanished from a listing and later reappears is a real event, not a judgement about
  // identity. Only `superseded` is permanent.
  const s = stored({ gone: true, goneReason: 'rescan' });
  mergeItems(s, [{ internalId: OLD, record: rec, at: '2026-09-01T09:00:00.000Z' }]);
  assert.ok(!s.items[OLD].gone, 'a rescan tombstone is not permanent');
});

test('and a fresh superseded tombstone can still be applied over a live entry', () => {
  const s = stored({});
  mergeItems(s, [{ internalId: OLD, record: rec, gone: true, goneReason: 'superseded', at: '2026-09-01T09:00:00.000Z' }]);
  assert.equal(s.items[OLD].gone, true, 'the cleanup itself must be able to retire a live entry');
});
