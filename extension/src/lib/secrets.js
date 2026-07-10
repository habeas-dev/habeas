import { chrome } from './ext.js';
import { encryptValue, decryptValue, isEncrypted } from './crypto.js';
import { getOrCreateSecretKey } from './keystore.js';
// Secrets store — SEPARATE from config, referenced by `secret://<name>`.
// Holds sink credentials (OAuth tokens, pairing tokens). NEVER referenced from an
// adapter or included in exportable config.
//
// Encrypted at rest with AES-GCM (see crypto.js). storage.local is plaintext on disk, so
// values live here as {v,iv,ct} envelopes; the key is a non-extractable CryptoKey in
// IndexedDB (keystore.js). This keeps raw credentials out of storage.local — it is not a
// defense against an attacker who already holds the browser profile (see crypto.js).
const KEY = 'habeas:secrets';

// Key provider is injectable so tests can supply an in-memory key without IndexedDB.
let keyProvider = getOrCreateSecretKey;
let keyPromise = null;
const getKey = () => (keyPromise ||= keyProvider());
export function _setKeyProvider(fn) { keyProvider = fn; keyPromise = null; } // test seam

export async function setSecret(name, value) {
  const o = await chrome.storage.local.get(KEY);
  const s = o[KEY] || {};
  s[name] = await encryptValue(await getKey(), value);
  await chrome.storage.local.set({ [KEY]: s });
}

// Low-level helpers for other modules that keep their own encrypted-at-rest values in storage.local
// (e.g. the Drive token cache) using the SAME key as the secrets store. encryptString returns an
// envelope to persist; decryptString returns the plaintext, or null on any failure (never throws).
export async function encryptString(plaintext) {
  return encryptValue(await getKey(), plaintext);
}
export async function decryptString(payload) {
  try { return await decryptValue(await getKey(), payload); } catch { return null; }
}

export async function getSecret(ref) {
  if (!ref) return null;
  const name = String(ref).replace(/^secret:\/\//, '');
  const o = await chrome.storage.local.get(KEY);
  const s = o[KEY] || {};
  const stored = s[name];
  if (stored == null) return null;
  if (!isEncrypted(stored)) {
    // Legacy plaintext (written before at-rest encryption): return it, and migrate in place
    // so it doesn't sit unencrypted after the first read. Best-effort — a failed re-encrypt
    // must not break the read.
    setSecret(name, stored).catch(() => {});
    return stored;
  }
  try {
    return await decryptValue(await getKey(), stored);
  } catch {
    return null; // wrong/rotated key or tampered payload
  }
}
