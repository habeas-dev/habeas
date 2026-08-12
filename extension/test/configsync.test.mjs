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

test('a device that unions the remote on write also ADOPTS it locally', async () => {
  // The reported failure: sinks configured on one browser stayed invisible on the other, for good.
  // writeSnapshotIfChanged adopts the remote into what it WRITES (so a smaller local view can't clobber
  // the shared snapshot) and then records that savedAt as "applied". Without adopting it LOCALLY too,
  // applyStoredConfigIfNewer later sees savedAt <= at and skips forever — the device permanently misses
  // whatever the other one had.
  reset();
  SNAP = { v: 1, savedAt: 500, datasources: [], sinks: [{ id: 'dbx-other', type: 'dropbox', name: 'Dropbox (other browser)' }], routes: [] };
  mem['habeas:config'] = { datasources: [], sinks: [{ id: 'dbx-mine', type: 'dropbox', name: 'Dropbox (this browser)' }], routes: [] };

  assert.equal(await writeSnapshotIfChanged(null, 1000), true);
  assert.equal(SNAP.sinks.length, 2, 'the shared snapshot keeps both, as it already did');

  const ids = (cfgOf().sinks || []).map((s) => s.id).sort();
  assert.deepEqual(ids, ['dbx-mine', 'dbx-other'],
    'the other browser’s sink must land in the LOCAL config too, not only in the snapshot');
});

test('…and having adopted it, the device does not then re-push or loop', async () => {
  reset();
  SNAP = { v: 1, savedAt: 500, datasources: [], sinks: [{ id: 'dbx-other', type: 'dropbox' }], routes: [] };
  mem['habeas:config'] = { datasources: [], sinks: [{ id: 'dbx-mine', type: 'dropbox' }], routes: [] };
  await writeSnapshotIfChanged(null, 1000);
  assert.equal(await writeSnapshotIfChanged(null, 2000), false, 'nothing changed since → no second write');
  assert.equal(SNAP.savedAt, 1000);
});

test('an OLDER snapshot still contributes what this device is missing, without overwriting it', async () => {
  // Heals a device already stuck: its own last write pushed `at` past the snapshot's savedAt, so the
  // timestamp gate skipped forever. Union is idempotent, so "is it newer?" is the wrong question for
  // entries we simply do not have — but an older snapshot must NOT win on an id we do have.
  reset();
  mem['habeas:config-synced'] = { at: 9000, sig: 'stale' };
  mem['habeas:config'] = { datasources: [], sinks: [{ id: 'dbx-mine', type: 'dropbox', name: 'mine, renamed here' }], routes: [] };
  SNAP = { v: 1, savedAt: 500, datasources: [], routes: [],
    sinks: [{ id: 'dbx-mine', type: 'dropbox', name: 'an older name' }, { id: 'dbx-other', type: 'dropbox', name: 'from the other browser' }] };

  assert.equal(await applyStoredConfigIfNewer(), true, 'the missing sink should still be adopted');
  const sinks = cfgOf().sinks;
  assert.equal(sinks.length, 2);
  assert.equal(sinks.find((s) => s.id === 'dbx-mine').name, 'mine, renamed here',
    'a stale snapshot must not overwrite a newer local edit');
  assert.ok(sinks.find((s) => s.id === 'dbx-other'), 'the entry this device lacked is added');
});

test('an older snapshot with nothing new is a no-op', async () => {
  reset();
  mem['habeas:config-synced'] = { at: 9000, sig: 'stale' };
  mem['habeas:config'] = { datasources: [], sinks: [{ id: 'dbx-mine', type: 'dropbox' }], routes: [] };
  SNAP = { v: 1, savedAt: 500, datasources: [], sinks: [{ id: 'dbx-mine', type: 'dropbox' }], routes: [] };
  assert.equal(await applyStoredConfigIfNewer(), false);
});
