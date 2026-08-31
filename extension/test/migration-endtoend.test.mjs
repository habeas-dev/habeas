// The test that was missing, and its absence is the whole story of this bug.
//
// supersededIds had eight tests, written before the code, all green. retireSupersededDuplicates was
// exercised through them. And the archive still came back doubled, because the defect lived in the SEAM:
// the migration's first phase re-normalizes records and stamps each one with the CURRENT source version,
// and its second phase distinguishes copies BY that version. Run separately both are correct. Run in
// order — which is the only way they ever run — phase one erases what phase two needs, and the tidy-up
// truthfully reports "nothing to do" over a visibly duplicated archive.
//
// Unit tests over fixtures I wrote myself could not catch that: they encoded my model of the data, not the
// data the pipeline actually produces. So this one runs the WHOLE migration over a seeded store and asserts
// the outcome the user cares about — the duplicates are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k == null ? { ...LOCAL } : Array.isArray(k) ? Object.fromEntries(k.map((x) => [x, LOCAL[x]])) : { [k]: LOCAL[k] }),
  set: async (o) => { Object.assign(LOCAL, o); },
  remove: async (k) => { for (const x of [].concat(k)) delete LOCAL[x]; },
} }, i18n: { getMessage: (k) => k } };

const { setBackend: _setBackend } = await import('../src/lib/store.js');
const { runStoreMigration } = await import('../src/lib/migrate.js');

// WiZink as it really is: movements keyed by a natural key, whose SHAPE changed in 0.10.2.
const ADAPTERS = { 'wizink-es': {
  id: 'wizink-es', service: 'wizink', version: '2026-08-28', schema: 'transaction@1', currency: 'EUR',
  categories: ['card'],
  streams: [{ id: 'movimientos', schema: 'transaction@1', api: { host: 'https://w.test', list: { path: '/m', itemsPath: 'm', paging: 'none' } },
    fields: { internalId: 'id', date: 'date', amount: 'amount', description: 'description' } }],
  api: { host: 'https://w.test', list: { path: '/m', itemsPath: 'm', paging: 'none' } },
  fields: { internalId: 'id', date: 'date', amount: 'amount', description: 'description' },
} };

const rec = { date: '2026-08-14', amount: -12.4, currency: 'EUR', description: 'Panaderia La Espiga', group: 'WiZink Oro 0000', category: 'card' };
const OLD = 'ACC0|14 AGO|12,40 €|PANADERIA LA ESPIGA|0';   // the identity the source can no longer produce
const NEW = 'ACC0|2026-08-14|-12.4|panaderia la espiga|0'; // what it produces now
const LONE = 'ACC0|02 FEB|55,00 €|GASOLINERA|0';           // older than 90 days: never re-listed, only copy

function fakeBackend(items) {
  const store = { 'wizink-es:movimientos': { meta: {}, items: JSON.parse(JSON.stringify(items)) } };
  return { store, backend: {
    listSources: async () => Object.keys(store),
    loadSource: async (id) => store[id] || null,
    saveSource: async (id, data) => { store[id] = data; },
  } };
}

test('the whole migration clears the duplicates it was written to clear', async () => {
  for (const k of Object.keys(LOCAL)) delete LOCAL[k];
  const { store, backend } = fakeBackend({
    [OLD]:  { record: rec, at: '2026-08-14T10:00:00.000Z', srcVersion: '2026-08-26' },
    [NEW]:  { record: rec, at: '2026-08-29T10:00:00.000Z', srcVersion: '2026-08-28' },
    [LONE]: { record: { ...rec, date: '2026-02-02', amount: -55, description: 'Gasolinera' }, at: '2026-02-02T10:00:00.000Z', srcVersion: '2026-08-26' },
  });
  _setBackend(backend);
  const r = await runStoreMigration(ADAPTERS, { force: true });

  const items = store['wizink-es:movimientos'].items;
  assert.equal(items[OLD].gone, true, 'the superseded copy is retired');
  assert.equal(items[OLD].goneReason, 'superseded');
  assert.ok(!items[NEW].gone, 'the copy the source still produces stays');
  assert.ok(!items[LONE].gone, 'and the movement with no newer twin is untouched — the 90-day guarantee');
  assert.equal(r.retired, 1, 'and it is reported, not done silently');
});

test('it still works after re-normalization has overwritten the version — the seam that failed', async () => {
  // Both copies stamped with the CURRENT version, which is what the first phase does to them. Before the
  // fix this returned "nothing to do" while the archive was plainly doubled.
  for (const k of Object.keys(LOCAL)) delete LOCAL[k];
  const { store, backend } = fakeBackend({
    [OLD]: { record: rec, at: '2026-08-14T10:00:00.000Z', srcVersion: '2026-08-28' },
    [NEW]: { record: rec, at: '2026-08-29T10:00:00.000Z', srcVersion: '2026-08-28' },
  });
  _setBackend(backend);
  const r = await runStoreMigration(ADAPTERS, { force: true });
  const items = store['wizink-es:movimientos'].items;
  assert.equal(items[OLD].gone, true, 'the stale identity is still recognised without the version');
  assert.ok(!items[NEW].gone);
  assert.equal(r.retired, 1);
});

test('running it twice changes nothing the second time', async () => {
  for (const k of Object.keys(LOCAL)) delete LOCAL[k];
  const { store, backend } = fakeBackend({
    [OLD]: { record: rec, at: '2026-08-14T10:00:00.000Z', srcVersion: '2026-08-26' },
    [NEW]: { record: rec, at: '2026-08-29T10:00:00.000Z', srcVersion: '2026-08-28' },
  });
  _setBackend(backend);
  await runStoreMigration(ADAPTERS, { force: true });
  const second = await runStoreMigration(ADAPTERS, { force: true });
  assert.equal(second.retired, 0, 'idempotent: nothing left to retire');
  assert.equal(store['wizink-es:movimientos'].items[NEW].gone, undefined, 'and it never eats the survivor');
});
