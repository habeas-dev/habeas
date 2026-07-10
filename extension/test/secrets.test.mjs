// Secrets store encrypted at rest: values are AES-GCM envelopes in storage.local, never
// plaintext. Stubs chrome.storage.local in memory and injects a stable in-memory key
// (IndexedDB keystore isn't available in node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from '../src/lib/crypto.js';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k == null ? { ...LOCAL } : { [k]: LOCAL[k] }),
  set: async (obj) => { Object.assign(LOCAL, obj); },
} } };

const { setSecret, getSecret, encryptString, decryptString, _setKeyProvider } = await import('../src/lib/secrets.js');
const KEY = await generateSecretKey();
_setKeyProvider(async () => KEY);

const reset = () => { for (const k of Object.keys(LOCAL)) delete LOCAL[k]; };

test('setSecret stores an encrypted envelope, never plaintext', async () => {
  reset();
  await setSecret('http-1', 'Bearer eyJ.tok');
  const raw = LOCAL['habeas:secrets']['http-1'];
  assert.equal(raw.v, 1);
  assert.notEqual(raw.ct, 'Bearer eyJ.tok');
  assert.ok(!JSON.stringify(LOCAL).includes('eyJ.tok'), 'no plaintext anywhere in storage.local');
});

test('getSecret round-trips, with secret:// prefix optional', async () => {
  reset();
  await setSecret('http-1', 'Bearer eyJ.tok');
  assert.equal(await getSecret('secret://http-1'), 'Bearer eyJ.tok');
  assert.equal(await getSecret('http-1'), 'Bearer eyJ.tok');
});

test('missing or empty ref → null', async () => {
  reset();
  assert.equal(await getSecret('secret://nope'), null);
  assert.equal(await getSecret(''), null);
  assert.equal(await getSecret(null), null);
});

test('legacy plaintext is returned and migrated to an envelope in place', async () => {
  reset();
  LOCAL['habeas:secrets'] = { 'http-1': 'plain-legacy-token' };
  assert.equal(await getSecret('http-1'), 'plain-legacy-token');
  await new Promise((r) => setTimeout(r, 20)); // let the best-effort re-encrypt settle
  assert.equal(LOCAL['habeas:secrets']['http-1'].v, 1, 'now an encrypted envelope');
  assert.equal(await getSecret('http-1'), 'plain-legacy-token', 'still decodes to the same value');
});

test('an envelope encrypted under a different key decrypts to null (no throw)', async () => {
  reset();
  await setSecret('http-1', 'x');
  _setKeyProvider(async () => await generateSecretKey());
  assert.equal(await getSecret('http-1'), null);
  _setKeyProvider(async () => KEY); // restore
});

test('encryptString/decryptString round-trip on the same store key', async () => {
  const p = await encryptString('drive-access-token');
  assert.ok(p.v === 1 && p.iv && p.ct);
  assert.equal(await decryptString(p), 'drive-access-token');
});

test('decryptString returns null on a bad/tampered payload (never throws)', async () => {
  assert.equal(await decryptString({ v: 1, iv: 'AAAAAAAAAAAAAAAA', ct: 'BBBBBBBB' }), null);
});
