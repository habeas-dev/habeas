// Canonical store — public API over an injected in-memory backend (IndexedDB isn't available in node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setBackend, putItems, recordDelivered, markGone, getRecords, getViews, countLive, migrate } from '../src/lib/store.js';

function mem() {
  const db = {};
  return { db, async loadSource(id) { return db[id] || null; }, async saveSource(id, d) { db[id] = d; }, async listSources() { return Object.keys(db); } };
}
const rec = (id, date, total, category) => ({ internalId: id, date, total, category });

test('putItems + getRecords: write-through then project (newest first)', async () => {
  const b = mem(); setBackend(b);
  await putItems('amazon-es', [
    { internalId: '1', record: rec('1', '2026-01-01', 10, 'shopping') },
    { internalId: '2', record: rec('2', '2026-03-01', 20, 'shopping') },
  ], { source: 'amazon-es' });
  const recs = await getRecords('amazon-es');
  assert.deepEqual(recs.map((r) => r.internalId), ['2', '1']);
  assert.equal(await countLive('amazon-es'), 2);
});

test('recordDelivered stores each doc.record; a record-only consumer is served from the store', async () => {
  const b = mem(); setBackend(b);
  const docs = [
    { internalId: 'A', record: rec('A', '2026-02-01', 5, 'grocery') },
    { internalId: 'B', record: rec('B', '2026-02-02', 6, 'fuel') },
  ];
  await recordDelivered('carrefour-es', docs);
  // consumer that only accepts grocery, nothing delivered to it yet → served from the store, no re-extract
  const forConsumer = await getRecords('carrefour-es', { accepts: (r) => r.category === 'grocery' });
  assert.deepEqual(forConsumer.map((r) => r.internalId), ['A']);
});

test('markGone tombstones items; they drop out of projections but views count them', async () => {
  const b = mem(); setBackend(b);
  await putItems('s', [{ internalId: 'x', record: rec('x', '2026-01-01') }, { internalId: 'y', record: rec('y', '2026-01-02') }]);
  await markGone('s', ['y'], 'retention');
  assert.deepEqual((await getRecords('s')).map((r) => r.internalId), ['x']);
  const v = await getViews('s', {});
  assert.equal(v.live, 1); assert.equal(v.gone, 1); assert.deepEqual(v.missed, ['y']);
});

test('concurrent reads of the same source coalesce into ONE backend load (store-on-Dropbox read amplification)', async () => {
  let loads = 0;
  const b = mem();
  const slow = { ...b, async loadSource(id) { loads++; await new Promise((r) => setTimeout(r, 5)); return b.db[id] || null; } };
  setBackend(slow);
  await putItems('s', [{ internalId: '1', record: rec('1', '2026-01-01', 5) }]);
  loads = 0; // ignore the read-merge inside putItems
  // Two surfaces (Archive + popup) render the same source at the same time → must not both hit the backend.
  const [a, c] = await Promise.all([getRecords('s'), getRecords('s')]);
  assert.deepEqual(a.map((r) => r.internalId), ['1']);
  assert.deepEqual(c.map((r) => r.internalId), ['1']);
  assert.equal(loads, 1, 'the two concurrent reads should share a single backend load');
});

test('a read AFTER the prior one settled loads fresh (coalescing is in-flight only, never a stale memo)', async () => {
  let loads = 0;
  const b = mem();
  const counted = { ...b, async loadSource(id) { loads++; return b.db[id] || null; } };
  setBackend(counted);
  await putItems('s', [{ internalId: '1', record: rec('1', '2026-01-01', 5) }]);
  loads = 0;
  await getRecords('s');
  await getRecords('s'); // sequential → a genuinely fresh read, not served from an in-flight promise
  assert.equal(loads, 2, 'sequential reads each load fresh (no TTL memo that could serve stale data)');
});

test('migrate: union every source from one backend into another (moving the store between backends)', async () => {
  const a = mem(); const b = mem();
  setBackend(a);
  await putItems('s', [{ internalId: '1', record: rec('1', '2026-01-01', 5) }]);
  await putItems('t', [{ internalId: 'x', record: rec('x', '2026-02-01', 9) }]);
  setBackend(b);
  await putItems('s', [{ internalId: '2', record: rec('2', '2026-03-01', 7) }]); // target already has some 's' data
  await migrate(a, b); // union a → b, never clobbering
  setBackend(b);
  assert.deepEqual((await getRecords('s')).map((r) => r.internalId).sort(), ['1', '2']);
  assert.deepEqual((await getRecords('t')).map((r) => r.internalId), ['x']); // whole source moved too
});
