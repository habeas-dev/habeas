// Some sources regenerate their own identifier on every sync — the same movement arrives with a fresh UUID
// each time — and no natural key covers them (nothing in the row is both distinguishing and stable). The
// consumer dedupes by internalId because that is what the contract promises, so it files the movement again
// on every pass. Where Habeas cannot promise stability, it must SAY so, rather than let the consumer trust
// an id that was never trustworthy — then the consumer can fall back to its own composite key.
//
// All values SYNTHETIC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord } from '../src/sinks/format.js';
import { canonicalize } from '../src/lib/normalize.js';

const DOC = { internalId: 'c0ffee00-0000-4000-8000-000000000001', date: '2026-03-14', amount: -12.4, description: 'Panaderia La Espiga', currency: 'EUR' };

test('by default a record says nothing — an id IS stable unless declared otherwise', () => {
  const rec = buildRecord(DOC, { schema: 'transaction@1', currency: 'EUR' });
  assert.equal(rec.idStable, undefined, 'no flag on the overwhelming majority of sources');
  assert.equal(canonicalize(rec).idStable, undefined, 'and none in the canonical form either');
});

test('a source that declares its id unstable stamps every record it produces', () => {
  const rec = buildRecord(DOC, { schema: 'transaction@1', currency: 'EUR', unstableId: true });
  assert.equal(rec.idStable, false, 'the record must carry the warning, not just the source definition');
});

test('and it survives into the canonical record the consumer receives', () => {
  // The canonical form is what an http consumer is handed. A warning that does not reach it is no warning.
  const rec = buildRecord(DOC, { schema: 'transaction@1', currency: 'EUR', unstableId: true });
  const c = canonicalize(rec);
  assert.equal(c.idStable, false, 'the consumer must be able to see that this id must not be a dedupe key');
  assert.equal(c.id, DOC.internalId, 'the id is still delivered — it is just not promised to be stable');
});

test('a per-STREAM declaration works too, since only one of a source’s streams may be affected', () => {
  // ING's card charges churn while its account movements do not. The flag has to be settable where the
  // difference actually lives.
  const rec = buildRecord(DOC, { schema: 'transaction@1', currency: 'EUR', api: {}, unstableId: true });
  assert.equal(rec.idStable, false);
});
