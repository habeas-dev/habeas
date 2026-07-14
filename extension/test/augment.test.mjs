import { test } from 'node:test';
import assert from 'node:assert/strict';
import { augmentSource, flatToStream } from '../src/runtime/infer.js';
import { resolveOutput, outputsOf } from '../src/lib/outputs.js';
import { validateAdapter } from '../src/adapters/validate.js';

// A FLAT existing source (e.g. a bank the author only captured account movements for).
const FLAT = {
  id: 'bank-es', name: 'Bank ES', service: 'bank', trust: 'community', domain: 'bank.es', country: 'ES',
  version: '2026-07-14', categories: ['banking'], match: ['https://bank.es/*'], auth: { mode: 'bearer', tokenMatch: '^Bearer eyJ', replayHeaders: ['authorization'] },
  schema: 'transaction@1',
  api: { host: 'https://api.bank.es', groups: { path: '/accounts', itemsPath: 'accounts', fields: { id: 'id', name: 'name' } }, list: { path: '/accounts/{group.id}/movements', paging: 'offset', itemsPath: 'movements' } },
  fields: { internalId: 'id', date: 'date', amount: 'amount' },
};

// A NEW stream a contributor inferred for the missing product (cards) — as flatToStream would yield.
const CARD_STREAM = {
  id: 'tarjetas', name: 'Tarjetas', schema: 'transaction@1',
  api: { groups: { path: '/cards', itemsPath: 'cards', fields: { id: 'id', name: 'name' } }, list: { path: '/cards/{group.id}/movements', paging: 'offset', itemsPath: 'movements' } },
  fields: { internalId: 'id', date: 'date', amount: 'amount' },
};

test('augmentSource lifts a flat base into a stream and appends the new one', () => {
  const out = augmentSource(FLAT, CARD_STREAM);
  assert.equal(out.streams.length, 2);
  // shared api is now just the host; the flat list/groups moved into the first stream
  assert.deepEqual(out.api, { host: 'https://api.bank.es' });
  assert.ok(!('fields' in out) && !('schema' in out)); // moved into the stream
  const [s0, s1] = out.streams;
  assert.equal(s0.id, 'principal'); assert.ok(s0.api.list && s0.api.groups && s0.fields);
  assert.equal(s1.id, 'tarjetas'); assert.ok(s1.api.list && s1.api.groups);
  // identity preserved
  assert.equal(out.id, 'bank-es'); assert.deepEqual(out.auth, FLAT.auth);
});

test('resolveOutput reconstructs each stream over the shared base', () => {
  const out = augmentSource(FLAT, CARD_STREAM);
  const eff0 = resolveOutput(out, 'principal');
  assert.equal(eff0.api.host, 'https://api.bank.es');
  assert.equal(eff0.api.list.path, '/accounts/{group.id}/movements');
  assert.equal(eff0.schema, 'transaction@1');
  const eff1 = resolveOutput(out, 'tarjetas');
  assert.equal(eff1.api.host, 'https://api.bank.es');           // inherited from base
  assert.equal(eff1.api.list.path, '/cards/{group.id}/movements'); // from the added stream
  assert.equal(outputsOf(out).length, 2);
});

test('the augmented source validates', () => {
  const out = augmentSource(FLAT, CARD_STREAM);
  const v = validateAdapter(out);
  assert.ok(v.ok, JSON.stringify(v));
});

test('augmenting an ALREADY-streamed source just appends', () => {
  const streamed = augmentSource(FLAT, CARD_STREAM);           // now has 2 streams
  const out2 = augmentSource(streamed, { ...CARD_STREAM, id: 'inversion', schema: 'investment@1', fields: { internalId: 'id', date: 'date', amount: 'amount' } });
  assert.equal(out2.streams.length, 3);
  assert.deepEqual(out2.streams.map((s) => s.id), ['principal', 'tarjetas', 'inversion']);
  assert.ok(validateAdapter(out2).ok);
});

test('flatToStream de-nests a flat adapter (host stays out, list/fields go in)', () => {
  const st = flatToStream(FLAT, 'movimientos');
  assert.equal(st.id, 'movimientos');
  assert.ok(st.api.list && st.api.groups && st.fields && st.schema === 'transaction@1');
  assert.ok(!st.api.host); // host is shared, never per-stream
});
