// AES-GCM value encryption used to protect the secrets store at rest. Pure WebCrypto,
// so it runs under node's globalThis.crypto exactly as it does in the extension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, encryptValue, decryptValue } from '../src/lib/crypto.js';

test('round-trips a value through encrypt → decrypt', async () => {
  const k = await generateSecretKey();
  const p = await encryptValue(k, 'Bearer eyJ.secret.token');
  assert.equal(p.v, 1);
  assert.ok(p.iv && p.ct);
  assert.ok(!JSON.stringify(p).includes('secret.token'), 'ciphertext must not contain the plaintext');
  assert.equal(await decryptValue(k, p), 'Bearer eyJ.secret.token');
});

test('each encryption uses a fresh IV, so equal plaintext yields different ciphertext', async () => {
  const k = await generateSecretKey();
  const a = await encryptValue(k, 'same');
  const b = await encryptValue(k, 'same');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.equal(await decryptValue(k, a), 'same');
  assert.equal(await decryptValue(k, b), 'same');
});

test('decryption fails with a different key', async () => {
  const [k1, k2] = [await generateSecretKey(), await generateSecretKey()];
  const p = await encryptValue(k1, 'x');
  await assert.rejects(() => decryptValue(k2, p));
});

test('tampered ciphertext is rejected (GCM authentication)', async () => {
  const k = await generateSecretKey();
  const p = await encryptValue(k, 'x');
  const bad = { ...p, ct: (p.ct[0] === 'A' ? 'B' : 'A') + p.ct.slice(1) };
  await assert.rejects(() => decryptValue(k, bad));
});

test('preserves unicode', async () => {
  const k = await generateSecretKey();
  assert.equal(await decryptValue(k, await encryptValue(k, 'niño€🔐 值')), 'niño€🔐 值');
});
