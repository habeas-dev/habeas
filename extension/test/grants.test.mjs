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

test('grantUsableBy binds a grant to exactly its origin', () => {
  const grant = { id: 'g', origin: 'https://a.app' };
  assert.ok(g.grantUsableBy(grant, 'https://a.app'));
  assert.ok(!g.grantUsableBy(grant, 'https://b.app'), 'another origin cannot use it');
  assert.ok(!g.grantUsableBy(null, 'https://a.app'));
  assert.ok(!g.grantUsableBy(grant, ''));
});
