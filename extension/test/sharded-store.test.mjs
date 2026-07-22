import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShardedStore } from '../src/lib/store/sharded.js';

// An in-memory file backend: a flat map of store-root-relative path -> object, with the 5 primitives the
// sharded layer needs. `writes` logs every write path so a test can assert which shards were touched.
function memPrim() {
  const files = new Map();
  const writes = [];
  const clone = (o) => JSON.parse(JSON.stringify(o));
  return {
    files, writes,
    async read(p) { return files.has(p) ? clone(files.get(p)) : null; },
    async write(p, o) { writes.push(p); files.set(p, clone(o)); },
    async remove(p) { files.delete(p); },
    async removeDir(dir) { const pre = dir + '/'; for (const p of [...files.keys()]) if (p.startsWith(pre)) files.delete(p); },
    async listChildren(dir) {
      const pre = dir ? dir + '/' : '';
      const names = new Map();
      for (const path of files.keys()) {
        if (!path.startsWith(pre)) continue;
        const rest = path.slice(pre.length); if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash === -1) names.set(rest, false); else names.set(rest.slice(0, slash), true);
      }
      return [...names].map(([name, isDir]) => ({ name, isDir }));
    },
  };
}
const entry = (id, date) => ({ internalId: id, record: { internalId: id, date, total: 5, source: 'amazon-es' }, at: '2026-07-01T00:00:00Z' });
const ids = (data) => Object.keys((data && data.items) || {}).sort();

test('appendItems splits items into monthly shards; loadSource reassembles them', async () => {
  const p = memPrim(); const s = makeShardedStore(p);
  await s.appendItems('amazon-es', [entry('A1', '2025-01-15'), entry('A2', '2025-01-20'), entry('A3', '2025-03-02')]);
  assert.ok(p.files.has('amazon-es/2025-01.json') && p.files.has('amazon-es/2025-03.json'), 'one file per month');
  assert.deepEqual(p.files.get('amazon-es/2025-01.json').items && Object.keys(p.files.get('amazon-es/2025-01.json').items).sort(), ['A1', 'A2']);
  assert.deepEqual(ids(await s.loadSource('amazon-es')), ['A1', 'A2', 'A3'], 'all items reassembled');
  assert.deepEqual(p.files.get('amazon-es/_meta.json').shards.sort(), ['2025-01', '2025-03']);
});

test('appendItems touches ONLY the shards a batch spans (bounded write cost)', async () => {
  const p = memPrim(); const s = makeShardedStore(p);
  await s.appendItems('amazon-es', [entry('A1', '2025-01-15'), entry('A3', '2025-03-02')]);
  p.writes.length = 0; // reset the write log
  await s.appendItems('amazon-es', [entry('A4', '2025-03-09')]); // a new March order
  assert.ok(p.writes.includes('amazon-es/2025-03.json'), 'the March shard is rewritten');
  assert.ok(!p.writes.includes('amazon-es/2025-01.json'), 'the January shard is NOT touched');
  assert.deepEqual(ids(await s.loadSource('amazon-es')), ['A1', 'A3', 'A4']);
});

test('an item with no parseable date lands in the _undated shard', async () => {
  const p = memPrim(); const s = makeShardedStore(p);
  await s.appendItems('x', [entry('N1', ''), entry('N2', null), entry('D1', '2025-06-01')]);
  assert.ok(p.files.has('x/_undated.json') && p.files.has('x/2025-06.json'));
  assert.deepEqual(Object.keys(p.files.get('x/_undated.json').items).sort(), ['N1', 'N2']);
});

test('a legacy single <id>.json is reformatted into month shards on load (auto-migration)', async () => {
  const p = memPrim(); const s = makeShardedStore(p);
  p.files.set('amazon-es.json', { meta: { source: 'amazon-es' }, items: {
    A1: { record: { internalId: 'A1', date: '2024-11-02' }, at: '1' },
    A2: { record: { internalId: 'A2', date: '2025-02-08' }, at: '1' },
  } });
  const data = await s.loadSource('amazon-es');
  assert.deepEqual(ids(data), ['A1', 'A2'], 'all legacy items are returned');
  assert.ok(!p.files.has('amazon-es.json'), 'the legacy single file is gone after reformat');
  assert.ok(p.files.has('amazon-es/2024-11.json') && p.files.has('amazon-es/2025-02.json'), 'split into month shards');
});

test('a passive read (interactive:false) does NOT reformat a legacy file', async () => {
  const p = memPrim(); const s = makeShardedStore(p);
  p.files.set('amazon-es.json', { meta: {}, items: { A1: { record: { internalId: 'A1', date: '2024-11-02' }, at: '1' } } });
  const data = await s.loadSource('amazon-es', { interactive: false });
  assert.deepEqual(ids(data), ['A1'], 'still returns the data');
  assert.ok(p.files.has('amazon-es.json'), 'but leaves the legacy file untouched (no token to write)');
});

test('listSources returns both sharded folders and legacy single files', async () => {
  const p = memPrim(); const s = makeShardedStore(p);
  await s.appendItems('amazon-es', [entry('A1', '2025-01-15')]); // sharded
  p.files.set('dia-es.json', { meta: {}, items: {} });            // legacy
  assert.deepEqual((await s.listSources()).sort(), ['amazon-es', 'dia-es']);
});

test('saveSource prunes shards for months that no longer have items', async () => {
  const p = memPrim(); const s = makeShardedStore(p);
  await s.appendItems('x', [entry('A1', '2025-01-15'), entry('A3', '2025-03-02')]);
  const data = await s.loadSource('x');
  delete data.items.A3; // drop the only March item
  await s.saveSource('x', data);
  assert.ok(!p.files.has('x/2025-03.json'), 'the emptied March shard is pruned');
  assert.ok(p.files.has('x/2025-01.json'));
  assert.deepEqual(ids(await s.loadSource('x')), ['A1']);
});

test('countLive sums the per-period counts from _meta with a single read (no full reassembly)', async () => {
  const p = memPrim(); const s = makeShardedStore(p);
  await s.appendItems('amazon-es', [entry('A1', '2025-01-15'), entry('A2', '2025-01-20'), entry('A3', '2025-03-02')]);
  p.writes.length = 0; const reads = []; const origRead = p.read;
  p.read = async (path) => { reads.push(path); return origRead(path); };
  assert.equal(await s.countLive('amazon-es'), 3);
  assert.deepEqual(reads, ['amazon-es/_meta.json'], 'only _meta was read, not every shard');
});

test('clearSource removes the whole source (folder + legacy); it stops being listed', async () => {
  const p = memPrim(); const s = makeShardedStore(p);
  await s.appendItems('x', [entry('A1', '2025-01-15')]);
  p.files.set('y.json', { meta: {}, items: {} });
  await s.clearSource('x');
  await s.clearSource('y');
  assert.equal(await s.loadSource('x'), null);
  assert.deepEqual(await s.listSources(), []);
});
