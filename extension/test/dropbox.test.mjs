// Dropbox sink: refreshes a short-lived access token via the stored refresh token, uploads each file +
// a cumulative per-source manifest, and reuses the cached token. Stubs storage.local + the secrets key
// (no IndexedDB/chrome.identity in node) and mocks the Dropbox HTTP API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from '../src/lib/crypto.js';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k == null ? { ...LOCAL } : { [k]: LOCAL[k] }),
  set: async (o) => { Object.assign(LOCAL, o); },
  remove: async (k) => { delete LOCAL[k]; },
} } };

const { _setKeyProvider, setSecret } = await import('../src/lib/secrets.js');
const { dropboxWrite } = await import('../src/sinks/dropbox.js');
const KEY = await generateSecretKey();
_setKeyProvider(async () => KEY);
const reset = () => { for (const k of Object.keys(LOCAL)) delete LOCAL[k]; };

function mockDbx() {
  const calls = [], store = {};
  globalThis.fetch = async (url, init = {}) => {
    const arg = init.headers && init.headers['Dropbox-API-Arg'];
    calls.push({ url, arg, auth: init.headers && init.headers.Authorization });
    if (url.includes('/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'ACCESS', expires_in: 14400 }) };
    if (url.includes('/files/upload')) { store[JSON.parse(arg).path] = typeof init.body === 'string' ? init.body : await init.body.text(); return { ok: true, status: 200, json: async () => ({}) }; }
    if (url.includes('/files/download')) { const p = JSON.parse(arg).path; return store[p] != null ? { ok: true, status: 200, json: async () => JSON.parse(store[p]) } : { ok: false, status: 409 }; }
    throw new Error('unexpected ' + url);
  };
  return { calls, store, restore: () => { delete globalThis.fetch; } };
}

test('dropbox: refreshes the access token, uploads files + a merged manifest, reuses the cached token', async () => {
  reset();
  await setSecret('dbx', 'REFRESH_TOKEN');
  const { calls, store, restore } = mockDbx();
  const sink = { id: 'dbx', type: 'dropbox', appKey: 'APPKEY', refreshRef: 'secret://dbx', rootFolderName: 'Habeas' };
  const mk = (id, date) => [{ internalId: id, date, total: 5, source: 'demo-es', type: 'receipt' }, new Map([[id, [{ blob: new Blob(['%PDF'], { type: 'application/pdf' }), ext: 'pdf' }]]])];

  const [d1, f1] = mk('A1', '2026-01-02');
  assert.equal((await dropboxWrite(sink, [d1], f1, { service: 'documents', source: 'demo-es' })).written, 1);
  const uploads = () => calls.filter((c) => c.url.includes('/files/upload'));
  assert.ok(calls.some((c) => c.url.includes('/oauth2/token')), 'refreshed once');
  assert.ok(uploads().length >= 2, 'uploaded the PDF + the manifest');
  assert.ok(uploads().every((c) => c.auth === 'Bearer ACCESS'), 'bearer of the refreshed token');

  const refreshesBefore = calls.filter((c) => c.url.includes('/oauth2/token')).length;
  const [d2, f2] = mk('A2', '2026-02-02');
  await dropboxWrite(sink, [d2], f2, { service: 'documents', source: 'demo-es' });
  assert.equal(calls.filter((c) => c.url.includes('/oauth2/token')).length, refreshesBefore, 'reused the cached token');

  const mfPath = Object.keys(store).find((p) => p.endsWith('/documents/demo-es.json'));
  assert.equal(JSON.parse(store[mfPath]).length, 2, 'manifest accumulates across runs');
  assert.ok(!JSON.stringify(LOCAL).includes('ACCESS'), 'access token cached encrypted, not in plaintext');
  restore();
});

test('dropbox: not connected (no app key / refresh token) throws', async () => {
  reset();
  await assert.rejects(() => dropboxWrite({ id: 'x', type: 'dropbox' }, [], new Map(), {}), /not connected/);
});
