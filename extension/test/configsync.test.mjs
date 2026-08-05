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

// The METHOD: a device must ADOPT the remote canonical config, never overwrite it with a bare local copy. A
// device that hasn't pulled yet (fire-and-forget on startup) or simply has fewer sinks/sources must not SHRINK
// the shared snapshot. writeSnapshotIfChanged reads the remote and unions it under the local edit (local wins).
test('writeSnapshotIfChanged ADOPTS the remote snapshot — never shrinks it with a local-only copy', async () => {
  reset();
  // The shared snapshot already carries device-B's extra source + sink.
  SNAP = buildSnapshot({ datasources: [{ id: 'a', enabled: true }, { id: 'fromB', enabled: true }], sinks: [{ id: 'sB', type: 'drive' }], routes: [{ id: 'rB', datasource: 'fromB', sink: 'sB', mode: 'auto' }] }, 5000);
  // THIS device only knows source 'a' and just edited it — a strictly smaller local view.
  mem['habeas:config'] = { datasources: [{ id: 'a', enabled: true, groups: ['acc1'] }], sinks: [], routes: [] };
  assert.equal(await writeSnapshotIfChanged(null, 9000), true, 'a real local change → write');
  assert.ok(SNAP.datasources.find((d) => d.id === 'fromB'), 'remote-only source preserved (not clobbered)');
  assert.ok(SNAP.sinks.find((s) => s.id === 'sB'), 'remote-only sink preserved');
  assert.ok(SNAP.routes.find((r) => r.id === 'rB'), 'remote-only route preserved');
  assert.deepEqual(SNAP.datasources.find((d) => d.id === 'a').groups, ['acc1'], 'the local edit still wins on the shared id');
  assert.equal(SNAP.savedAt, 9000);
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

test('missingAdapterIds: community adapters a config uses but the device lacks (built-ins present are ignored)', async () => {
  const { missingAdapterIds } = await import('../src/lib/configsync.js');
  const cfg = { datasources: [{ id: 'ing-es', adapter: 'ing-es' }, { id: 'pepeenergy-es', adapter: 'pepeenergy-es' }, { id: 'carrefour-es', adapter: 'carrefour-es' }] };
  const installed = { 'carrefour-es': {} }; // only carrefour is installed here
  assert.deepEqual(missingAdapterIds(cfg, installed).sort(), ['ing-es', 'pepeenergy-es']);
  assert.deepEqual(missingAdapterIds({ datasources: [] }, {}), []);
  assert.deepEqual(missingAdapterIds(cfg, { 'ing-es': {}, 'pepeenergy-es': {}, 'carrefour-es': {} }), []); // all present
});
