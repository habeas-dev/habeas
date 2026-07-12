// The Drive Path-B OAuth token cached in storage.local (gdrive:<clientId>) is encrypted at rest:
// only expiresAt stays plaintext. Path A (chrome.identity.getAuthToken) is absent here, so getToken
// falls through to the cached-token path. Stubs storage.local and injects the secrets key (no
// IndexedDB / chrome.identity in node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from '../src/lib/crypto.js';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k == null ? { ...LOCAL } : { [k]: LOCAL[k] }),
  set: async (obj) => { Object.assign(LOCAL, obj); },
  remove: async (k) => { delete LOCAL[k]; },
} } }; // no chrome.identity → hasChromeAuth() is false → Path B

const { _setKeyProvider, encryptString, decryptString } = await import('../src/lib/secrets.js');
const { driveSignIn, driveConnected, driveDeviceConnect, _setSleep } = await import('../src/sinks/drive.js');
const KEY = await generateSecretKey();
_setKeyProvider(async () => KEY);

const reset = () => { for (const k of Object.keys(LOCAL)) delete LOCAL[k]; };
const future = () => Date.now() + 1e6;

test('a valid encrypted cache entry decrypts to the token, with no network/prompt', async () => {
  reset();
  LOCAL['gdrive:test'] = { tokenEnc: await encryptString('ACCESS_TOK'), expiresAt: future() };
  assert.ok(!JSON.stringify(LOCAL).includes('ACCESS_TOK'), 'token not stored in plaintext');
  assert.equal(await driveSignIn('test'), 'ACCESS_TOK');
  assert.equal(await driveConnected('test'), true);
});

test('legacy plaintext cache entry is still honored', async () => {
  reset();
  LOCAL['gdrive:test'] = { token: 'LEGACY_TOK', expiresAt: future() };
  assert.equal(await driveSignIn('test'), 'LEGACY_TOK');
  assert.equal(await driveConnected('test'), true);
});

test('driveConnected is false when the cached token is expired or absent', async () => {
  reset();
  assert.equal(await driveConnected('test'), false);
  LOCAL['gdrive:test'] = { tokenEnc: await encryptString('X'), expiresAt: Date.now() - 1 };
  assert.equal(await driveConnected('test'), false);
});

// ---- Path C: device flow (Firefox — no redirect, refresh-token silent renewal) --------------------

test('Path C: an expired access token is renewed silently via the stored refresh token', async () => {
  reset();
  LOCAL['gdrive:test'] = { tokenEnc: await encryptString('OLD'), expiresAt: Date.now() - 1, refreshEnc: await encryptString('RT') };
  let body = '';
  globalThis.fetch = async (url, init) => { body = String(init.body); assert.ok(url.includes('/token')); return { ok: true, status: 200, json: async () => ({ access_token: 'NEW', expires_in: 3600 }) }; };
  assert.equal(await driveSignIn('test'), 'NEW');           // cached expired → refresh, not a prompt
  assert.ok(body.includes('grant_type=refresh_token') && body.includes('refresh_token=RT'));
  assert.equal(await decryptString(LOCAL['gdrive:test'].tokenEnc), 'NEW'); // new access cached
  assert.ok(LOCAL['gdrive:test'].refreshEnc, 'refresh token preserved');   // refresh responses omit it
  delete globalThis.fetch;
});

test('Path C: driveConnected is true with a refresh token even when the access token expired', async () => {
  reset();
  LOCAL['gdrive:test'] = { tokenEnc: await encryptString('X'), expiresAt: Date.now() - 1, refreshEnc: await encryptString('RT') };
  assert.equal(await driveConnected('test'), true); // can renew silently → connected
});

test('Path C: device flow shows a user code, polls past authorization_pending, stores the refresh token', async () => {
  reset();
  _setSleep(async () => {}); // instant polling
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/device/code')) return { ok: true, status: 200, json: async () => ({ device_code: 'DC', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', interval: 1, expires_in: 600 }) };
    if (url.includes('/token')) { calls++; return calls === 1
      ? { ok: false, status: 428, json: async () => ({ error: 'authorization_pending' }) }
      : { ok: true, status: 200, json: async () => ({ access_token: 'ACC', refresh_token: 'RT2', expires_in: 3600 }) }; }
    throw new Error('unexpected ' + url);
  };
  let shown = null;
  const tok = await driveDeviceConnect('test', (info) => { shown = info; });
  assert.equal(tok, 'ACC');
  assert.equal(shown.user_code, 'ABCD-EFGH');       // surfaced to the UI
  assert.equal(calls, 2);                            // pending → success
  assert.equal(await decryptString(LOCAL['gdrive:test'].refreshEnc), 'RT2');
  assert.equal(await driveConnected('test'), true);
  delete globalThis.fetch;
});
