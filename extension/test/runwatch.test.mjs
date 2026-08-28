// When a run stops without finishing, the extension must SAY so. That is the whole lesson of the stall
// that went four days unnoticed: a run that fails logs, badges and notifies; a run whose background is
// killed underneath it leaves no trace at all — the status line keeps its last words and looks busy.
//
// This also settles which failure we are actually looking at, on the user's own machine and without
// changing their destinations: if the background is being SUSPENDED mid-run (Firefox event page, Chrome
// worker recycle), the next start-up finds a run marked in-flight that nobody ever closed, and says which
// phase it died in. If instead a request simply hung, the run closes itself with a timeout error. The two
// are then distinguishable in the activity log rather than by guesswork.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  // Mirrors the real API: a key, an ARRAY of keys, or null for everything.
  get: async (k) => (k == null ? { ...LOCAL } : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, LOCAL[x]])) : { [k]: LOCAL[k] }),
  set: async (o) => { Object.assign(LOCAL, o); },
  remove: async (k) => { delete LOCAL[k]; },
} } };

const { beginRun, markPhase, endRun, takeUnfinishedRun } = await import('../src/lib/runwatch.js');
const reset = () => { for (const k of Object.keys(LOCAL)) delete LOCAL[k]; };
// A suspension means the background comes back as a FRESH instance — new module state, but the same
// storage. That is what a restart has to be modelled as; re-using the live instance would be testing
// something that cannot happen.
// Literal specifiers (not a computed one) so the packager can see exactly what is imported.
const BOOTS = [
  () => import('../src/lib/runwatch.js?restart=1'),
  () => import('../src/lib/runwatch.js?restart=2'),
  () => import('../src/lib/runwatch.js?restart=3'),
  () => import('../src/lib/runwatch.js?restart=4'),
];
let gen = 0;
const restart = () => BOOTS[gen++]();

test('a run that completes leaves nothing behind to report', async () => {
  reset();
  await beginRun({ kind: 'auto', datasource: 'wizink', sink: 'dbx1' });
  await markPhase('listing');
  await endRun();
  assert.equal(await takeUnfinishedRun(), null, 'a closed run must not be reported as unfinished');
});

test('a run killed mid-flight is found on the next start-up, with the phase it died in', async () => {
  reset();
  await beginRun({ kind: 'auto', datasource: 'wizink', sink: 'dbx1' });
  await markPhase('listing');
  await markPhase('retrieving from dbx1'); // …and here the background goes away. No endRun.

  const orphan = await (await restart()).takeUnfinishedRun();
  assert.ok(orphan, 'the next start-up must find it');
  assert.equal(orphan.phase, 'retrieving from dbx1', 'and know where it stopped');
  assert.equal(orphan.datasource, 'wizink');
  assert.equal(orphan.sink, 'dbx1');
  assert.ok(orphan.startedAt, 'and when it began');
});

test('it is reported ONCE — a start-up loop must not log the same corpse every time', async () => {
  reset();
  await beginRun({ kind: 'auto', datasource: 'wizink', sink: 'dbx1' });
  await markPhase('listing');
  const boot1 = await restart();
  assert.ok(await boot1.takeUnfinishedRun(), 'first start-up reports it');
  const boot2 = await restart();
  assert.equal(await boot2.takeUnfinishedRun(), null, 'the second must not');
});

test('a new run does not inherit the previous one’s corpse', async () => {
  reset();
  await beginRun({ kind: 'auto', datasource: 'wizink', sink: 'dbx1' });
  await markPhase('listing');
  await beginRun({ kind: 'manual', datasource: 'ing', sink: 'dbx1' }); // started before anyone looked
  const orphan = await takeUnfinishedRun();
  assert.ok(orphan, 'the abandoned one is still reported');
  assert.equal(orphan.datasource, 'wizink', 'and it is the ABANDONED run, not the live one');
  await endRun();
  assert.equal(await takeUnfinishedRun(), null, 'the live run closed cleanly and is not reported');
});

test('marking a phase is cheap enough to call in a per-document loop', async () => {
  reset();
  let writes = 0;
  const realSet = globalThis.chrome.storage.local.set;
  globalThis.chrome.storage.local.set = async (o) => { writes++; return realSet(o); };
  await beginRun({ kind: 'auto', datasource: 'wizink', sink: 'dbx1' });
  const before = writes;
  for (let i = 0; i < 500; i++) await markPhase('retrieving ' + i + '/500');
  globalThis.chrome.storage.local.set = realSet;
  assert.ok(writes - before <= 20, `a per-document marker must not write 500 times (wrote ${writes - before})`);
});

test('start-up reads only its own keys, never the whole of storage', async () => {
  // A whole-storage read deserializes every ledger, log and document index on the way past. Doing that at
  // start-up would add cost to the exact moment this is meant to protect.
  reset();
  await beginRun({ kind: 'auto', datasource: 'wizink', sink: 'dbx1' });
  const asked = [];
  const realGet = globalThis.chrome.storage.local.get;
  globalThis.chrome.storage.local.get = async (k) => { asked.push(k); return realGet(k); };
  try { await (await restart()).takeUnfinishedRun(); }
  finally { globalThis.chrome.storage.local.get = realGet; }
  assert.ok(asked.length > 0, 'it must read something');
  for (const k of asked) assert.notEqual(k, null, 'never a whole-storage read');
});
