// A "group" endpoint can return ONE object instead of a list: the account the user has open (Stripe's
// /v1/accounts/{id}). listGroups treats a lone object as a one-element list instead of failing to iterate it.
// Every value is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listGroups } from '../src/runtime/inventory.js';

const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });

test('groups: a single-object response is one group', async () => {
  const adapter = { id: 'demo', api: { host: 'https://dash.example.com', groups: { path: '/v1/accounts/{ctx.acct}', itemsPath: '', fields: { id: 'id', label: 'settings.dashboard.display_name' } }, list: { path: '/x' } } };
  const urls = [];
  const net = async (url) => { urls.push(url); return ok({ id: 'acct_000EXAMPLE', settings: { dashboard: { display_name: 'Demo account' } } }); };
  const groups = await listGroups(adapter, { merged: {}, byPath: {}, ctx: { acct: 'acct_000EXAMPLE' } }, net);
  assert.equal(urls[0], 'https://dash.example.com/v1/accounts/acct_000EXAMPLE');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'acct_000EXAMPLE');
  assert.equal(groups[0].label, 'Demo account');
});

test('groups: a list response is unchanged, and a missing path yields no groups', async () => {
  const mk = (body, itemsPath) => listGroups({ id: 'demo', api: { host: 'https://d.example.com', groups: { path: '/g', itemsPath, fields: { id: 'id' } }, list: { path: '/x' } } }, {}, async () => ok(body));
  assert.deepEqual((await mk({ data: [{ id: 'a' }, { id: 'b' }] }, 'data')).map((g) => g.id), ['a', 'b']);
  assert.deepEqual(await mk({ other: 1 }, 'data'), []);
});
