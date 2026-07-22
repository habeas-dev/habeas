import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShardedStore } from '../src/lib/store/sharded.js';

// An in-memory backend implementing the SEMANTIC shard ops the layer needs. `writes` logs every writeShard so
// a test can assert which shards were touched. Shards live in a map keyed "id/name"; legacy blobs in their own.
function memBackend() {
  const shards = new Map(), legacy = new Map(), writes = [];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const k = (id, name) => id + '/' + name;
  return {
    shards, legacy, writes,
    async readShard(id, name) { return shards.has(k(id, name)) ? clone(shards.get(k(id, name))) : null; },
    async writeShard(id, name, o) { writes.push(k(id, name)); shards.set(k(id, name), clone(o)); },
    async removeShard(id, name) { shards.delete(k(id, name)); },
    async listShardNames(id) { const out = []; for (const key of shards.keys()) { const i = key.indexOf('/'); if (key.slice(0, i) === id && key.slice(i + 1) !== '_meta') out.push(key.slice(i + 1)); } return out; },
    async listSourceIds() { const s = new Set(); for (const key of shards.keys()) s.add(key.slice(0, key.indexOf('/'))); for (const i of legacy.keys()) s.add(i); return [...s]; },
    async readLegacy(id) { return legacy.has(id) ? clone(legacy.get(id)) : null; },
    async removeLegacy(id) { legacy.delete(id); },
    async removeSource(id) { for (const key of [...shards.keys()]) if (key.slice(0, key.indexOf('/')) === id) shards.delete(key); legacy.delete(id); },
  };
}
const entry = (id, date) => ({ internalId: id, record: { internalId: id, date, total: 5, source: 'amazon-es' }, at: '2026-07-01T00:00:00Z' });
const ids = (data) => Object.keys((data && data.items) || {}).sort();
const has = (b, id, name) => b.shards.has(id + '/' + name);
const shardItems = (b, id, name) => Object.keys((b.shards.get(id + '/' + name) || { items: {} }).items).sort();

test('appendItems splits items into monthly shards; loadSource reassembles them', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  await s.appendItems('amazon-es', [entry('A1', '2025-01-15'), entry('A2', '2025-01-20'), entry('A3', '2025-03-02')]);
  assert.ok(has(b, 'amazon-es', '2025-01') && has(b, 'amazon-es', '2025-03'), 'one shard per month');
  assert.deepEqual(shardItems(b, 'amazon-es', '2025-01'), ['A1', 'A2']);
  assert.deepEqual(ids(await s.loadSource('amazon-es')), ['A1', 'A2', 'A3'], 'all items reassembled');
});

test('the shards store ONLY items — no derived data (counts/shard-lists) is persisted', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  await s.appendItems('amazon-es', [entry('A1', '2025-01-15')], { source: 'amazon-es', srcVersion: '1' });
  assert.deepEqual(Object.keys(b.shards.get('amazon-es/2025-01')), ['items'], 'a month shard holds only { items }');
  assert.deepEqual(Object.keys(b.shards.get('amazon-es/_meta')), ['meta'], '_meta holds only { meta } (source metadata, not derived)');
  assert.deepEqual(b.shards.get('amazon-es/_meta').meta, { source: 'amazon-es', srcVersion: '1' });
});

test('appendItems touches ONLY the shards a batch spans (bounded write cost)', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  await s.appendItems('amazon-es', [entry('A1', '2025-01-15'), entry('A3', '2025-03-02')]);
  b.writes.length = 0;
  await s.appendItems('amazon-es', [entry('A4', '2025-03-09')]);
  assert.ok(b.writes.includes('amazon-es/2025-03'), 'the March shard is rewritten');
  assert.ok(!b.writes.includes('amazon-es/2025-01'), 'the January shard is NOT touched');
  assert.deepEqual(ids(await s.loadSource('amazon-es')), ['A1', 'A3', 'A4']);
});

test('no date → _undated; a year-only date (Amazon list) buckets by year, not _undated', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  await s.appendItems('x', [entry('N1', ''), entry('N2', null), entry('D1', '2025-06-01'), entry('Y1', '2025'), entry('Y2', '2024')]);
  assert.ok(has(b, 'x', '_undated') && has(b, 'x', '2025-06') && has(b, 'x', '2025') && has(b, 'x', '2024'));
  assert.deepEqual(shardItems(b, 'x', '_undated'), ['N1', 'N2'], 'truly dateless → _undated');
  assert.deepEqual(shardItems(b, 'x', '2025'), ['Y1'], 'year-only 2025 → the 2025 shard, not _undated');
});

test('a document MOVES to its month shard when its date becomes precise (no duplicate in the year shard)', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  await s.appendItems('amazon-es', [entry('A1', '2025')]);          // first stored year-only (detail not yet analyzed)
  assert.deepEqual(shardItems(b, 'amazon-es', '2025'), ['A1']);
  await s.appendItems('amazon-es', [entry('A1', '2025-03-15')]);    // re-stored with the real date from the detail
  assert.deepEqual(shardItems(b, 'amazon-es', '2025-03'), ['A1'], 'now in the month shard');
  assert.ok(!has(b, 'amazon-es', '2025') || shardItems(b, 'amazon-es', '2025').length === 0, 'gone from the year shard');
  assert.deepEqual(ids(await s.loadSource('amazon-es')), ['A1'], 'exactly one copy after reassembly');
});

test('a document also moves out of _undated once it gains any date', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  await s.appendItems('x', [entry('U1', '')]);                      // no date → _undated
  assert.deepEqual(shardItems(b, 'x', '_undated'), ['U1']);
  await s.appendItems('x', [entry('U1', '2024-11-02')]);            // date learned
  assert.deepEqual(shardItems(b, 'x', '2024-11'), ['U1']);
  assert.ok(!has(b, 'x', '_undated') || shardItems(b, 'x', '_undated').length === 0, 'no longer in _undated');
  assert.deepEqual(ids(await s.loadSource('x')), ['U1']);
});

test('loadSource self-heals entries left in the wrong shard (year-dated records dumped in _undated)', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  // Simulate what an older periodOf wrote: year-only records sitting in _undated.
  b.shards.set('amazon-es/_undated', { items: {
    O1: { record: { internalId: 'O1', date: '2026' }, at: '1' },
    O2: { record: { internalId: 'O2', date: '2025' }, at: '1' },
    U0: { record: { internalId: 'U0', date: '' }, at: '1' },
  } });
  const data = await s.loadSource('amazon-es');
  assert.deepEqual(ids(data), ['O1', 'O2', 'U0'], 'all items still returned');
  assert.deepEqual(shardItems(b, 'amazon-es', '2026'), ['O1'], 'the 2026 record moved to its year shard');
  assert.deepEqual(shardItems(b, 'amazon-es', '2025'), ['O2']);
  assert.deepEqual(shardItems(b, 'amazon-es', '_undated'), ['U0'], 'only the truly-dateless one stays in _undated');
});

test('a passive load does NOT self-heal misplaced shards (no write without a session)', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  b.shards.set('x/_undated', { items: { O1: { record: { internalId: 'O1', date: '2026' }, at: '1' } } });
  await s.loadSource('x', { interactive: false });
  assert.deepEqual(shardItems(b, 'x', '_undated'), ['O1'], 'left in place on a passive read');
  assert.ok(!has(b, 'x', '2026'));
});

test('a legacy single blob is reformatted into month shards on load (auto-migration)', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  b.legacy.set('amazon-es', { meta: { source: 'amazon-es' }, items: {
    A1: { record: { internalId: 'A1', date: '2024-11-02' }, at: '1' },
    A2: { record: { internalId: 'A2', date: '2025-02-08' }, at: '1' },
  } });
  const data = await s.loadSource('amazon-es');
  assert.deepEqual(ids(data), ['A1', 'A2'], 'all legacy items are returned');
  assert.ok(!b.legacy.has('amazon-es'), 'the legacy blob is gone after reformat');
  assert.ok(has(b, 'amazon-es', '2024-11') && has(b, 'amazon-es', '2025-02'), 'split into month shards');
});

test('a passive read (interactive:false) does NOT reformat a legacy blob', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  b.legacy.set('amazon-es', { meta: {}, items: { A1: { record: { internalId: 'A1', date: '2024-11-02' }, at: '1' } } });
  const data = await s.loadSource('amazon-es', { interactive: false });
  assert.deepEqual(ids(data), ['A1'], 'still returns the data');
  assert.ok(b.legacy.has('amazon-es'), 'but leaves the legacy blob untouched (no token to write)');
});

test('listSources returns both sharded sources and legacy ones', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  await s.appendItems('amazon-es', [entry('A1', '2025-01-15')]);
  b.legacy.set('dia-es', { meta: {}, items: {} });
  assert.deepEqual((await s.listSources()).sort(), ['amazon-es', 'dia-es']);
});

test('saveSource prunes shards for months that no longer have items', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  await s.appendItems('x', [entry('A1', '2025-01-15'), entry('A3', '2025-03-02')]);
  const data = await s.loadSource('x');
  delete data.items.A3;
  await s.saveSource('x', data);
  assert.ok(!has(b, 'x', '2025-03'), 'the emptied March shard is pruned');
  assert.ok(has(b, 'x', '2025-01'));
  assert.deepEqual(ids(await s.loadSource('x')), ['A1']);
});

test('hasItems is a cheap existence probe (listing only, no shard reads)', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  assert.equal(await s.hasItems('amazon-es'), false);
  await s.appendItems('amazon-es', [entry('A1', '2025-01-15')]);
  let reads = 0; const orig = b.readShard.bind(b); b.readShard = async (...a) => { reads++; return orig(...a); };
  assert.equal(await s.hasItems('amazon-es'), true);
  assert.equal(reads, 0, 'no shard was read — only the listing');
});

test('clearSource removes the whole source (shards + legacy); it stops being listed', async () => {
  const b = memBackend(); const s = makeShardedStore(b);
  await s.appendItems('x', [entry('A1', '2025-01-15')]);
  b.legacy.set('y', { meta: {}, items: {} });
  await s.clearSource('x'); await s.clearSource('y');
  assert.equal(await s.loadSource('x'), null);
  assert.deepEqual(await s.listSources(), []);
});
