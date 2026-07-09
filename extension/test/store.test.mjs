// Canonical store — public API over an injected in-memory backend (IndexedDB isn't available in node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setBackend, putItems, recordDelivered, markGone, getRecords, getViews, countLive, mergeFrom } from '../src/lib/store.js';

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

test('mergeFrom: rehydrate/union a source from another backend (moving the store)', async () => {
  const target = mem(); const other = mem();
  setBackend(other);
  await putItems('s', [{ internalId: '1', record: rec('1', '2026-01-01', 5) }]);
  setBackend(target);
  await putItems('s', [{ internalId: '2', record: rec('2', '2026-02-01', 9) }]);
  await mergeFrom('s', other); // union other's data into the current (target)
  assert.deepEqual((await getRecords('s')).map((r) => r.internalId).sort(), ['1', '2']);
});
