// AES-GCM value encryption for the secrets store. Pure WebCrypto (available in the MV3
// service worker, the UI pages, and node), no external deps. A single non-extractable
// CryptoKey (see keystore.js) encrypts each secret with a fresh 96-bit IV; GCM's tag
// authenticates the ciphertext so tampering is detected on decrypt.
//
// Honest scope: with no stable user secret in MV3, this is NOT protection against an
// attacker who already has the browser profile — it keeps plaintext credentials out of
// storage.local (so they can't leak via a config/storage export, logs, or a casual grep).

const te = new TextEncoder();
const td = new TextDecoder();

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Fresh 256-bit AES-GCM key. extractable:false → the raw bytes can never be read back out
// via JS (it survives in IndexedDB as an opaque handle), only used to encrypt/decrypt.
export function generateSecretKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptValue(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(String(plaintext)));
  return { v: 1, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptValue(key, payload) {
  const iv = fromB64(payload.iv);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, fromB64(payload.ct));
  return td.decode(pt);
}

// A payload is one of our encrypted envelopes (vs a legacy plaintext string).
export const isEncrypted = (x) => !!x && typeof x === 'object' && x.v === 1 && typeof x.iv === 'string' && typeof x.ct === 'string';
