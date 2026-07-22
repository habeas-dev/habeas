// Durability of chunked delivery: runRoute/sendStoredDocs now flush every CHUNK docs (writeToSink +
// ledger + store), so an interruption loses at most the in-flight chunk. writeToSink reads→merges→writes
// the per-source manifest, so a flushed chunk is DURABLE even if the next chunk never runs. This test pins
// that guarantee at the writeToSink level (the chunk loop lives in background.js, but this is the property
// it depends on): flush chunk 1, then "crash" → chunk 1's records survive; flush both → the manifest is
// the same as delivering all at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeToSink } from '../src/sinks/sinks.js';

function mockDav() {
  const store = {}; // url -> body text (the manifest GET reads back what was PUT)
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'GET') return store[url] != null ? { ok: true, status: 200, json: async () => JSON.parse(store[url]) } : { ok: false, status: 404, json: async () => [] };
    if (method === 'PUT') { store[url] = typeof init.body === 'string' ? init.body : await init.body.text(); return { ok: true, status: 201 }; }
    return { ok: true, status: 201 }; // MKCOL
  };
  return { store, restore: () => { delete globalThis.fetch; } };
}

const sink = { id: 'dav', type: 'webdav', url: 'https://dav.example.com/Habeas/', username: 'me' };
const mfOf = (store) => JSON.parse(store[Object.keys(store).find((u) => u.endsWith('/documents/demo-es.json'))] || 'null');
const chunk = (ids) => [
  ids.map((id) => ({ internalId: id, date: '2026-01-0' + id.slice(-1), total: 5, source: 'demo-es', type: 'receipt' })),
  new Map(ids.map((id) => [id, [{ blob: new Blob(['%PDF-1'], { type: 'application/pdf' }), ext: 'pdf' }]])),
];
const deliver = (docs, files, store) => writeToSink(sink, docs, files, { service: 'documents', source: 'demo-es' });

test('a checkpointed chunk survives an interruption before the next chunk', async () => {
  const { store, restore } = mockDav();
  const [d1, f1] = chunk(['1', '2', '3']);
  await deliver(d1, f1, store);            // chunk 1 flushed
  // ...then the operation is interrupted (Stop / SW recycled) — chunk 2 never runs.
  const mf = mfOf(store);
  assert.deepEqual(mf.map((r) => r.internalId).sort(), ['1', '2', '3'], 'chunk 1 records are durable on their own');
  restore();
});

test('chunked delivery == single delivery: the cumulative manifest is identical', async () => {
  const a = mockDav();
  const [d1, f1] = chunk(['1', '2', '3']); const [d2, f2] = chunk(['4', '5']);
  await deliver(d1, f1, a.store); await deliver(d2, f2, a.store); // two checkpoints
  const chunked = mfOf(a.store).map((r) => r.internalId).sort();
  a.restore();

  const b = mockDav();
  const [dAll, fAll] = chunk(['1', '2', '3', '4', '5']);
  await deliver(dAll, fAll, b.store); // one shot
  const single = mfOf(b.store).map((r) => r.internalId).sort();
  b.restore();

  assert.deepEqual(chunked, single, 'the same records land whether delivered in chunks or all at once');
  assert.deepEqual(chunked, ['1', '2', '3', '4', '5']);
});
