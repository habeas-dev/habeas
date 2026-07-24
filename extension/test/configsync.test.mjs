// Device-portable config sync: a config snapshot in the canonical store, merged into a second device (newest-wins
// per entry, union otherwise). Stubs chrome.storage.local (config + sync state) + an in-memory store backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (typeof k === 'string' ? { [k]: mem[k] } : {}),
  set: async (o) => { Object.assign(mem, o); },
} } };
const { buildSnapshot, mergeSnapshot, configSig, applyStoredConfigIfNewer, writeSnapshotIfChanged } = await import('../src/lib/configsync.js');
const { setBackend } = await import('../src/lib/store.js');

let SNAP = null;
setBackend({ async getConfig() { return SNAP; }, async putConfig(s) { SNAP = s; return true; }, async listSources() { return []; }, async loadSource() { return null; }, async saveSource() {} });
const reset = () => { for (const k of Object.keys(mem)) delete mem[k]; SNAP = null; };
const cfgOf = () => mem['habeas:config'];

test('mergeSnapshot: snapshot wins per shared id, local-only entries are kept', () => {
  const local = { datasources: [{ id: 'a', enabled: true, groups: ['x'] }, { id: 'localonly', enabled: true }], sinks: [{ id: 's1', type: 'http' }], routes: [] };
  const snap = { datasources: [{ id: 'a', enabled: false, groups: ['y'] }, { id: 'b', enabled: true }], sinks: [{ id: 's1', type: 'http', accepts: { schemas: ['transaction'] } }], routes: [{ id: 'r1', datasource: 'a', sink: 's1', mode: 'auto' }] };
  const m = mergeSnapshot(local, snap);
  assert.deepEqual(m.datasources.find((d) => d.id === 'a'), { id: 'a', enabled: false, groups: ['y'] }); // snap wins
  assert.ok(m.datasources.find((d) => d.id === 'localonly'), 'local-only kept');
  assert.ok(m.datasources.find((d) => d.id === 'b'), 'snap-only added');
  assert.deepEqual(m.sinks[0].accepts, { schemas: ['transaction'] });
  assert.equal(m.routes.length, 1);
});

test('writeSnapshotIfChanged writes on a real change and skips the unchanged (no ping-pong)', async () => {
  reset();
  mem['habeas:config'] = { datasources: [{ id: 'a', enabled: true }], sinks: [], routes: [] };
  assert.equal(await writeSnapshotIfChanged(null, 1000), true, 'first write');
  assert.equal(SNAP.savedAt, 1000);
  assert.equal(await writeSnapshotIfChanged(null, 2000), false, 'unchanged → no write');
  assert.equal(SNAP.savedAt, 1000, 'snapshot untouched');
  mem['habeas:config'].datasources[0].groups = ['acc1']; // a real edit
  assert.equal(await writeSnapshotIfChanged(null, 3000), true, 'changed → write');
  assert.equal(SNAP.savedAt, 3000);
});

test('applyStoredConfigIfNewer adopts a newer snapshot once, then not again (and no echo write)', async () => {
  reset();
  mem['habeas:config'] = { datasources: [{ id: 'a', enabled: true }], sinks: [], routes: [] };
  SNAP = buildSnapshot({ datasources: [{ id: 'a', enabled: true, groups: ['fromB'] }], sinks: [{ id: 'sB', type: 'drive' }], routes: [] }, 5000);
  assert.equal(await applyStoredConfigIfNewer(), true, 'applied');
  assert.deepEqual(cfgOf().datasources.find((d) => d.id === 'a').groups, ['fromB'], 'account selection adopted');
  assert.ok(cfgOf().sinks.find((s) => s.id === 'sB'), 'destination adopted');
  assert.equal(await applyStoredConfigIfNewer(), false, 'same snapshot not re-applied');
  // The apply set the sig to the merged config → a snapshot write right after must NOT echo it back.
  assert.equal(await writeSnapshotIfChanged(null, 6000), false, 'apply echo is not pushed back');
});

test('migrate carries the _config snapshot to the target backend (but never overwrites a newer one)', async () => {
  const { migrate } = await import('../src/lib/store.js');
  const mk = (snap) => { let s = snap || null; return { async listSources() { return []; }, async loadSource() { return null; }, async saveSource() {}, async getConfig() { return s; }, async putConfig(x) { s = x; return true; }, peek: () => s }; };
  const from = mk(buildSnapshot({ datasources: [{ id: 'a', enabled: true }], sinks: [], routes: [] }, 9000));
  const to = mk(null);
  await migrate(from, to);
  assert.equal(to.peek().savedAt, 9000, 'snapshot copied on move');
  // a target with a NEWER snapshot is not clobbered
  const to2 = mk(buildSnapshot({ datasources: [], sinks: [], routes: [] }, 99999));
  await migrate(from, to2);
  assert.equal(to2.peek().savedAt, 99999, 'newer target snapshot preserved');
});
