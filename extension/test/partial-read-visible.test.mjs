// The sharded loader already knows when it could not read part of an archive: a shard that fails to load
// marks the assembly `__partial`, so a transient cloud error is never mistaken for "those months are empty".
// Nothing downstream looked at the flag. So when the archive lives in Dropbox and something saturates it —
// a long migration, say — a failed shard read renders as movements that have vanished, and the user watches
// a month of their archive disappear and come back.
//
// A partial read must be VISIBLE. Showing fewer records than exist, with no indication that the reading
// itself failed, is the same silent-failure shape as everything else fixed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/lib/store/format.js';

const src = (extra) => ({ meta: {}, items: { a: { record: { date: '2026-08-01', amount: -1 } } }, ...extra });

test('a complete read is not flagged', () => {
  const out = project(src(), {});
  assert.ok(Array.isArray(out.records) || Array.isArray(out), 'records come back');
  assert.notEqual(out.partial, true);
});

test('a partial read is flagged, and still returns what it DID read', () => {
  const out = project(src({ __partial: true }), {});
  assert.equal(out.partial, true, 'the caller must be able to tell the user the reading failed');
  const recs = out.records || out;
  assert.equal(recs.length, 1, 'what was read is still shown — it is not an error, it is incomplete');
});
