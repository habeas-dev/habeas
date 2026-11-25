// Two runtime features a "every account in the profile" source needs (first: Stripe, whose dashboard session
// can act on any of the user's accounts by changing one header):
//  - groups.itemsPaths: ONE response holds the accounts in several lists (standalone accounts, and accounts
//    nested inside organizations). Every path is read and the lists are concatenated; a `key[]` segment
//    flattens an array of objects into their children.
//  - a list/pdf header that names {group.*} is the GROUP's value and wins over the captured header of the
//    same name — the captured Stripe-Account is the account that happened to be open, not the one listed.
//    A header whose {group.*} cannot be resolved (no group) leaves the captured value alone.
// Every value is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listGroups, listInventory, fetchPdf } from '../src/runtime/inventory.js';
import { validateAdapter } from '../src/adapters/validate.js';

const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
const RESP = {
  data: {
    accounts: {
      standalone: [{ aid: 'A1', name: 'One' }, { aid: 'A2', name: 'Two' }],
      merchants: [{ aid: 'A3', name: 'Three' }],
      organizations: [{ name: 'Org', workspaces: [{ aid: 'A4', name: 'Four' }, { aid: 'A5', name: 'Five' }] }, { name: 'Empty', workspaces: [] }],
    },
  },
};

function adapter(extra = {}) {
  return {
    id: 'demo', name: 'Demo', service: 'demo', schema: 'invoice@2', categories: ['banking'], match: ['https://dash.example.com/*'],
    auth: { tokenMatch: '^Bearer x', replayHeaders: ['authorization', 'x-account'] },
    api: {
      host: 'https://dash.example.com',
      groups: {
        path: '/graphql', method: 'POST', contentType: 'application/json', body: '{"query":"{ accounts { aid } }"}',
        itemsPaths: ['data.accounts.standalone', 'data.accounts.merchants', 'data.accounts.organizations[].workspaces'],
        fields: { id: 'aid', label: 'name' },
      },
      list: { path: '/v1/docs', itemsPath: 'data', paging: 'none', headers: { 'x-account': '{group.id}' } },
      pdf: { path: '/download/{internalId}', headers: { 'x-account': '{group.id}' } },
    },
    fields: { internalId: 'id', date: 'date' },
    ...extra,
  };
}
// The captured session: the open account is A9, which is none of the listed ones.
const AUTH = { merged: { authorization: 'Bearer xyz', 'x-account': 'A9' }, byPath: { '/v1/docs': { authorization: 'Bearer xyz', 'x-account': 'A9' } } };

test('groups.itemsPaths: concatenates every list, flattening key[] segments, in order', async () => {
  const calls = [];
  const groups = await listGroups(adapter(), AUTH, async (url, init) => { calls.push({ url, init }); return ok(RESP); });
  assert.deepEqual(groups.map((g) => g.id), ['A1', 'A2', 'A3', 'A4', 'A5']);
  assert.deepEqual(groups.map((g) => g.label), ['One', 'Two', 'Three', 'Four', 'Five']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{"query":"{ accounts { aid } }"}'); // GraphQL braces untouched
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
});

test('groups.itemsPaths: a missing path contributes nothing', async () => {
  const a = adapter();
  a.api.groups.itemsPaths = ['data.accounts.standalone', 'data.nothing', 'data.accounts.nothing[].x'];
  assert.deepEqual((await listGroups(a, AUTH, async () => ok(RESP))).map((g) => g.id), ['A1', 'A2']);
});

test('groups.itemsPaths validates against the adapter schema', () => {
  assert.deepEqual(validateAdapter(adapter()).errors || [], []);
});

test('a {group.*} list header wins over the captured header of the same name', async () => {
  const seen = [];
  const net = async (url, init) => {
    if (url.endsWith('/graphql')) return ok(RESP);
    seen.push(init.headers['x-account']);
    return ok({ data: [{ id: 'd-' + init.headers['x-account'], date: '2026-01-31' }] });
  };
  const docs = await listInventory(adapter(), AUTH, net);
  assert.deepEqual(seen, ['A1', 'A2', 'A3', 'A4', 'A5']);
  assert.equal(docs.length, 5);
  assert.equal(seen.includes('A9'), false);
});

test('a {group.*} pdf header carries the document\'s own account; with no group the captured value stays', async () => {
  const sent = [];
  const net = async (url, init) => {
    if (url.endsWith('/graphql')) return ok(RESP);
    if (url.includes('/download/')) { sent.push(init.headers['x-account']); return { ok: true, status: 200, blob: async () => new Blob(['%PDF']) }; }
    return ok({ data: [{ id: 'd-' + init.headers['x-account'], date: '2026-01-31' }] });
  };
  const a = adapter();
  const docs = await listInventory(a, AUTH, net);
  await fetchPdf(a, AUTH, docs.find((d) => d.internalId === 'd-A4'), net);
  assert.deepEqual(sent, ['A4']);
  await fetchPdf(a, AUTH, { internalId: 'd-loose' }, net); // no group at all
  assert.deepEqual(sent, ['A4', 'A9']);
});
