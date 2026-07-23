import { test } from 'node:test';
import assert from 'node:assert/strict';

// In-memory chrome.storage.local, installed BEFORE importing grants.js (which binds the ext shim).
const store = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k in store ? { [k]: store[k] } : {}),
  set: async (o) => { Object.assign(store, o); },
} } };

const g = await import('../src/lib/grants.js');

test('grant store: add, list by origin, get, revoke', async () => {
  await g.addGrant({ id: 'g1', origin: 'https://a.app', datasourceId: 'carrefour-es', sinkId: 'ext-a-app', filter: null, createdAt: 'x' });
  await g.addGrant({ id: 'g2', origin: 'https://b.app', datasourceId: 'carrefour-es', sinkId: 'ext-b-app', filter: null, createdAt: 'x' });
  assert.equal((await g.getGrants()).length, 2);
  assert.equal((await g.grantsForOrigin('https://a.app')).length, 1);
  assert.equal((await g.getGrant('g1')).origin, 'https://a.app');
  await g.revokeGrant('g1');
  assert.equal(await g.getGrant('g1'), null);
  assert.equal((await g.getGrants()).length, 1);
});

test('addGrant dedupes per (origin, route/kind): re-approving replaces, never stacks', async () => {
  await g.addGrant({ id: 'r1', origin: 'https://c.app', datasourceId: 'ing-es', sinkId: 's', filter: null, createdAt: 'x' });
  await g.addGrant({ id: 'r2', origin: 'https://c.app', datasourceId: 'ing-es', sinkId: 's', filter: null, createdAt: 'y' });
  await g.addGrant({ id: 'r3', origin: 'https://c.app', datasourceId: 'openbank', sinkId: 's', filter: null, createdAt: 'z' });
  const routes = (await g.grantsForOrigin('https://c.app')).filter((x) => x.datasourceId === 'ing-es');
  assert.equal(routes.length, 1, 'one grant per origin+source');
  assert.equal(routes[0].id, 'r2', 'the newest approval wins');
  // The list-sources capability grant dedupes on kind, and does not collide with route grants.
  await g.addGrant({ id: 'k1', origin: 'https://c.app', kind: 'list-sources', createdAt: 'x' });
  await g.addGrant({ id: 'k2', origin: 'https://c.app', kind: 'list-sources', createdAt: 'y' });
  const all = await g.grantsForOrigin('https://c.app');
  assert.equal(all.filter((x) => x.kind === 'list-sources').length, 1);
  assert.equal(all.length, 3, 'ing-es + openbank + list-sources');
});

test('grantUsableBy binds a grant to exactly its origin', () => {
  const grant = { id: 'g', origin: 'https://a.app' };
  assert.ok(g.grantUsableBy(grant, 'https://a.app'));
  assert.ok(!g.grantUsableBy(grant, 'https://b.app'), 'another origin cannot use it');
  assert.ok(!g.grantUsableBy(null, 'https://a.app'));
  assert.ok(!g.grantUsableBy(grant, ''));
});
