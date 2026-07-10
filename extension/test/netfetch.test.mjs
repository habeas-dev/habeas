// Regression: a page-context (in-tab) fetch is bound by that page's CSP (connect-src). When the tab sits
// on a page that doesn't allow the API host, the in-page fetch throws a network error surfaced as status 0
// ("Failed to fetch") — e.g. Carrefour listing while the tab is on the home/login page. netFetch must then
// retry DIRECTLY from the extension (host_permissions → no CORS), but must NOT retry on a real HTTP error
// (a 403 from Cloudflare is a genuine response and the tab is the only way through).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netFetch } from '../src/runtime/inventory.js';

const resp = (o) => ({ ok: o.status >= 200 && o.status < 300, status: o.status, text: async () => o.body || '', json: async () => JSON.parse(o.body || 'null') });

test('no tab → direct global fetch is used as-is', async () => {
  const calls = [];
  globalThis.fetch = async (u) => { calls.push(u); return resp({ status: 200, body: '{"ok":1}' }); };
  const f = netFetch(null);
  const r = await f('https://api.example.com/x', {});
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ['https://api.example.com/x']);
});

test('page-fetch network failure (status 0) → falls back to a direct extension fetch', async () => {
  let direct = 0;
  globalThis.fetch = async () => { direct++; return resp({ status: 200, body: '{"list":[1,2]}' }); };
  const net = async () => resp({ status: 0 }); // page CSP blocked connect-src → "Failed to fetch"
  const r = await netFetch(net)('https://pro.api.carrefour.es/p', {});
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"list":[1,2]}');
  assert.equal(direct, 1, 'direct fetch used exactly once');
});

test('page-fetch that THROWS → also falls back to direct', async () => {
  globalThis.fetch = async () => resp({ status: 200, body: 'ok' });
  const net = async () => { throw new TypeError('Failed to fetch'); };
  const r = await netFetch(net)('https://pro.api.carrefour.es/p', {});
  assert.equal(r.status, 200);
});

test('a real HTTP error (403 anti-bot) is NOT retried — the tab is the only way through', async () => {
  let direct = 0;
  globalThis.fetch = async () => { direct++; return resp({ status: 200, body: 'leaked' }); };
  const net = async () => resp({ status: 403, body: 'Just a moment…' });
  const r = await netFetch(net)('https://www.cloudflared.example/p', {});
  assert.equal(r.status, 403, 'keeps the tab response');
  assert.equal(direct, 0, 'no direct fallback on a genuine HTTP status');
});
