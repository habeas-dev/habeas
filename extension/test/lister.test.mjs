// The shared list core (runtime/lister.js) that BOTH the popup's "List documents" and the Archive's "Refresh"
// call — so they behave identically. Synthetic values only. Store goes to an injected in-memory backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSourceInto } from '../src/runtime/lister.js';
import { setBackend, getRecords } from '../src/lib/store.js';

const mem = () => { const db = {}; return { db, async loadSource(id) { return db[id] || null; }, async saveSource(id, d) { db[id] = d; }, async listSources() { return Object.keys(db); } }; };
const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const AUTH = { byPath: {}, merged: {} };
const flatAdapter = () => ({ id: 'flat', schema: 'receipt@1', api: { host: 'https://h.example', list: { paging: 'none', itemsPath: 'items' } }, fields: { internalId: 'id', date: 'd' } });

test('refuses a mismatched datasource/adapter pair — never cross-contaminates the store (race guard)', async () => {
  setBackend(mem());
  let hit = false;
  const net = async () => { hit = true; return json({ items: [{ id: '1', d: '2026-01-01' }] }); };
  // A race hands adapter=flat but ds declaring a DIFFERENT adapter (as if PepeEnergy's ds met Raisin's adapter).
  await assert.rejects(
    () => listSourceInto(flatAdapter(), { auth: AUTH, net, ds: { id: 'pepeenergy-es', adapter: 'raisin' } }),
    /mismatch/,
  );
  assert.equal(hit, false, 'bails before any network/store write');
  assert.deepEqual(await getRecords('pepeenergy-es'), [], 'nothing written under the wrong id');
});

test('lists a flat source into the store and reports counts', async () => {
  setBackend(mem());
  const net = async () => json({ items: [{ id: '1', d: '2026-01-01' }, { id: '2', d: '2026-02-01' }] });
  const r = await listSourceInto(flatAdapter(), { auth: AUTH, net, ds: {} });
  assert.equal(r.listed, 2);
  assert.equal(r.new, 2);
  assert.deepEqual((await getRecords('flat')).map((x) => x.internalId).sort(), ['1', '2']);
});

test('incremental (default): a second run pulls nothing new (knownIds seeded from the store)', async () => {
  setBackend(mem());
  const net = async () => json({ items: [{ id: '1', d: '2026-01-01' }] });
  await listSourceInto(flatAdapter(), { auth: AUTH, net, ds: {} });
  const r2 = await listSourceInto(flatAdapter(), { auth: AUTH, net, ds: {} });
  assert.equal(r2.new, 0, 'an already-known item is not counted as new');
});

test("mode:'full' re-enumerates the whole history; new counts only genuinely-unknown items", async () => {
  setBackend(mem());
  const net = async () => json({ items: [{ id: '1', d: '2026-01-01' }] });
  await listSourceInto(flatAdapter(), { auth: AUTH, net, ds: {} });
  const r = await listSourceInto(flatAdapter(), { auth: AUTH, net, ds: {}, mode: 'full' });
  assert.equal(r.listed, 1, 'full re-lists the item');
  assert.equal(r.new, 0, 'but it was already known → 0 new');
});

const groupedAdapter = () => ({ id: 'grp', schema: 'transaction@1', api: { host: 'https://h.example', groups: { path: '/accounts', itemsPath: 'entries', fields: { id: 'id' } }, list: { paging: 'none', itemsPath: 'items' } }, fields: { internalId: 'id', date: 'd' } });

test('grouped source: no saved allow-list → pickGroup is asked; a saved allow-list skips it', async () => {
  const net = async (url) => json(String(url).includes('/accounts') ? { entries: [{ id: 'A1' }, { id: 'A2' }] } : { items: [{ id: 'I1', d: '2026-01-01' }] });
  setBackend(mem());
  let asked = 0;
  await listSourceInto(groupedAdapter(), { auth: AUTH, net, ds: {}, pickGroup: async () => { asked++; return 'A1'; } });
  assert.equal(asked, 1, 'pickGroup asked once when there is no saved allow-list');
  setBackend(mem());
  asked = 0;
  await listSourceInto(groupedAdapter(), { auth: AUTH, net, ds: { groups: ['A1'] }, pickGroup: async () => { asked++; return 'A1'; } });
  assert.equal(asked, 0, 'pickGroup skipped when an account allow-list is saved');
});
