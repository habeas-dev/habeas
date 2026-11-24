// Two loopback services on different ports (the e2e fake bank and fake Stripe dashboard) store their captured
// sessions as auth:localhost:<port>. A source must get ITS port's session, never the other one's token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.chrome = { storage: { session: { get: async () => ({}) } } };
const { loadAuth } = await import('../src/lib/authstore.js');

test('loadAuth: the api.host port picks the session captured on that port', async () => {
  const all = {
    'auth:localhost:1111': { merged: { authorization: 'bearer eyJbank' }, byPath: { '/api/accounts': { authorization: 'bearer eyJbank' } }, ctx: {} },
    'auth:localhost:2222': { merged: { authorization: 'Bearer uk_dash', 'stripe-account': 'acct_x' }, byPath: { '/v1/x': { authorization: 'Bearer uk_dash' } }, ctx: { acct: 'acct_x' } },
  };
  for (const order of [all, Object.fromEntries(Object.entries(all).reverse())]) {
    const a = await loadAuth({ api: { host: 'http://localhost:2222' }, match: ['http://localhost/*'] }, order);
    assert.equal(a.merged.authorization, 'Bearer uk_dash');
    assert.equal(a.merged['stripe-account'], 'acct_x');
    assert.deepEqual(Object.keys(a.byPath), ['/v1/x']);
    assert.equal(a.ctx.acct, 'acct_x');
  }
});

test('loadAuth: a host without a port is unchanged', async () => {
  const all = { 'auth:api.example.com': { merged: { authorization: 'Bearer eyJa' }, byPath: {}, ctx: {} }, 'auth:www.example.com': { merged: { 'x-csrf-token': 't' }, byPath: {}, ctx: {} } };
  const a = await loadAuth({ api: { host: 'https://api.example.com' }, match: ['https://www.example.com/*'] }, all);
  assert.deepEqual(a.merged, { 'x-csrf-token': 't', authorization: 'Bearer eyJa' });
});
