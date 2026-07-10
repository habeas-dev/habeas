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

const { _setKeyProvider, encryptString } = await import('../src/lib/secrets.js');
const { driveSignIn, driveConnected } = await import('../src/sinks/drive.js');
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
