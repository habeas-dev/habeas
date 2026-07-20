// auth.tokenFromStorage: the bearer is read FRESH from the page's localStorage on every request (for SPAs
// that keep + rotate it there, e.g. FECI's aphishi-lws_at.t), instead of relying on capturing it from a seen
// request. We verify the injected page-function by running it in-process with a mocked localStorage + fetch.
// All values SYNTHETIC.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// chrome must exist BEFORE lib/ext.js binds it → set the mock, then dynamic-import.
let lastFetch = null;
const rec = { tokenReady: false, reloaded: 0 }; // controls the recoverAndReauth mock (a token appears after a reload)
globalThis.localStorage = { _v: {}, getItem(k) { return k in this._v ? this._v[k] : null; }, setItem(k, v) { this._v[k] = v; } };
globalThis.fetch = async (url, init) => { lastFetch = { url, init }; return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(0) }; };
globalThis.chrome = {
  scripting: { executeScript: async ({ func, args }) => [{ result: await func(args[0]) }] },
  tabs: { query: async () => [{ id: 1, url: 'https://api.example.com/dashboard' }], update: async () => { rec.reloaded++; return {}; }, create: async () => ({ id: 2 }), get: async () => ({ status: 'complete' }) },
  storage: { session: { get: async () => ({ 'auth:api.example.com': { merged: rec.tokenReady ? { authorization: 'Bearer FRESH' } : {}, byPath: {}, ctx: {} } }) } },
};
const { makePageFetch, recoverAndReauth } = await import('../src/lib/pagefetch.js');

const FECI_LIKE = { domain: 'example.com', match: ['https://api.example.com/*'], api: { host: 'https://api.example.com' }, auth: { mode: 'cookie', replayHeaders: ['authorization'] } };

test('recoverAndReauth reloads the tab and returns a refreshed auth + net once the token is re-captured', async () => {
  rec.tokenReady = false; rec.reloaded = 0;
  setTimeout(() => { rec.tokenReady = true; }, 15); // the SPA re-auths shortly after the reload → token captured
  const r = await recoverAndReauth(FECI_LIKE, { timeoutMs: 300, pollMs: 10 });
  assert.ok(rec.reloaded > 0, 'it reloaded the site tab');
  assert.ok(r && r.auth && r.auth.merged.authorization === 'Bearer FRESH', 'returns the freshly-captured token');
  assert.equal(typeof r.net, 'function', 'returns a fresh page-fetch');
});

test('recoverAndReauth returns best-effort (not null) when the token never re-appears', async () => {
  rec.tokenReady = false; rec.reloaded = 0;
  const r = await recoverAndReauth(FECI_LIKE, { timeoutMs: 60, pollMs: 10 });
  assert.ok(rec.reloaded > 0);
  assert.ok(r && typeof r.net === 'function', 'a cookie-only source can still serve on the reload'); // best-effort net
});

test('reads the bearer from a JSON localStorage field and injects Authorization: Bearer', async () => {
  globalThis.localStorage.setItem('aphishi-lws_at', JSON.stringify({ tt: 0, t: 'eyJHDR.eyPAYLOAD.SIG', u: 'user' }));
  const adapter = { auth: { mode: 'cookie', tokenFromStorage: { key: 'aphishi-lws_at', field: 't', scheme: 'Bearer' } } };
  const pf = makePageFetch(1, adapter);
  const resp = await pf('https://x.test/dashboard/user', { headers: { accept: 'application/json' } });
  assert.equal(lastFetch.init.headers.authorization, 'Bearer eyJHDR.eyPAYLOAD.SIG', 'fresh token injected');
  assert.equal(lastFetch.init.headers.accept, 'application/json', 'existing headers preserved');
  assert.ok(resp.sentHeaders.includes('authorization'), 'the response reports the REAL sent headers for accurate diagnostics');
});

test('a fresh storage token overrides a stale captured one', async () => {
  globalThis.localStorage.setItem('aphishi-lws_at', JSON.stringify({ t: 'FRESH.TOKEN.SIG' }));
  const adapter = { auth: { mode: 'cookie', tokenFromStorage: { key: 'aphishi-lws_at', field: 't', scheme: 'Bearer' } } };
  const pf = makePageFetch(1, adapter);
  await pf('https://x.test/a', { headers: { authorization: 'Bearer STALE.CAPTURED.SIG' } });
  assert.equal(lastFetch.init.headers.authorization, 'Bearer FRESH.TOKEN.SIG');
});

test('a plain (non-JSON) storage value is used as-is; a missing key adds no header', async () => {
  globalThis.localStorage.setItem('rawtok', 'PLAIN-TOKEN-VALUE');
  const pf1 = makePageFetch(1, { auth: { tokenFromStorage: { key: 'rawtok', scheme: 'Bearer' } } });
  await pf1('https://x.test/a', { headers: {} });
  assert.equal(lastFetch.init.headers.authorization, 'Bearer PLAIN-TOKEN-VALUE');

  const pf2 = makePageFetch(1, { auth: { tokenFromStorage: { key: 'absent', field: 't', scheme: 'Bearer' } } });
  await pf2('https://x.test/b', { headers: { accept: 'x' } });
  assert.equal(lastFetch.init.headers.authorization, undefined, 'no token → no header');
});

test('no tokenFromStorage config → requests are untouched', async () => {
  const pf = makePageFetch(1, { auth: { mode: 'cookie' } });
  await pf('https://x.test/a', { headers: { accept: 'y' } });
  assert.equal(lastFetch.init.headers.authorization, undefined);
});
