// Portable secrets vault — reuse your destinations' credentials (a Cuéntamo/Tiquetera exporter's pairing token,
// HTTP-sink headers, S3/WebDAV/Dropbox creds) across browsers. The device-local secrets store (secrets.js) is
// encrypted with a NON-extractable key that never leaves the browser, so it can't be synced. Instead this builds a
// SEPARATE bundle encrypted under a USER passphrase (PBKDF2 → AES-GCM) and stores only that ciphertext in the
// canonical store, beside the config snapshot. On another device the user enters the same passphrase once; the
// bundle decrypts and is imported into that device's own (device-encrypted) secrets store. The store — even a cloud
// one — only ever holds ciphertext that is useless without the passphrase. The bank SESSION token is NEVER here
// (it's memory-only, rule #3). The passphrase itself is never persisted; the derived key is cached only in
// storage.session (memory, cleared on browser close) so in-session secret changes re-sync without a re-prompt.
import { chrome } from './ext.js';
import { deriveKeyFromPassphrase, randomSaltB64, encryptValue, decryptValue, exportKeyB64, importKeyB64 } from './crypto.js';
import { exportAllSecrets, importSecrets } from './secrets.js';
import { getSecretsBlob, putSecretsBlob } from './store.js';

const STATE_KEY = 'habeas:vault';    // storage.local — non-secret metadata { enabled, salt, at }
const SESSION_KEY = 'habeas:vaultkey'; // storage.session — the derived key (raw b64), memory-only

async function getState() { try { return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {}; } catch (e) { return {}; } }
async function setState(st) { try { await chrome.storage.local.set({ [STATE_KEY]: st }); } catch (e) {} }
async function cacheKey(key) { try { await chrome.storage.session.set({ [SESSION_KEY]: await exportKeyB64(key) }); } catch (e) {} }
async function cachedKey() {
  try { const b64 = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY]; return b64 ? await importKeyB64(b64) : null; } catch (e) { return null; }
}
// Forget the unlocked key for this session (does NOT disable the vault or touch stored secrets).
export async function lockVault() { try { await chrome.storage.session.remove(SESSION_KEY); } catch (e) {} }

async function writeVault(key, salt) {
  const blob = await encryptValue(key, JSON.stringify(await exportAllSecrets()));
  const at = Date.now();
  const ok = await putSecretsBlob({ v: 1, salt, iv: blob.iv, ct: blob.ct, at });
  if (ok) await setState({ enabled: true, salt, at });
  return ok;
}

// Turn ON the vault (or reset its passphrase): derive a key from a fresh salt, encrypt the CURRENT local secrets,
// upload, and cache the key for the session. Returns true on success.
export async function enableVault(passphrase) {
  if (!passphrase) return false;
  const salt = randomSaltB64();
  const key = await deriveKeyFromPassphrase(passphrase, salt);
  const ok = await writeVault(key, salt);
  if (ok) await cacheKey(key);
  return ok;
}

// Re-encrypt + upload the vault after a local secret changed — ONLY if it's enabled AND unlocked this session
// (we hold the derived key). A no-op otherwise (never silently re-prompts). Returns true if it wrote.
export async function syncVaultIfUnlocked() {
  const st = await getState();
  if (!st.enabled || !st.salt) return false;
  const key = await cachedKey();
  if (!key) return false;
  return writeVault(key, st.salt);
}

// Unlock on another device: decrypt the remote vault with the passphrase and import its secrets into THIS device's
// store. Caches the key so later changes re-sync. Returns { ok, count } or { ok:false, reason }.
export async function unlockVault(passphrase) {
  const blob = await getSecretsBlob().catch(() => null);
  if (!blob || !blob.salt) return { ok: false, reason: 'no-vault' };
  let json;
  try {
    const key = await deriveKeyFromPassphrase(passphrase, blob.salt);
    json = await decryptValue(key, blob); // GCM tag mismatch on a wrong passphrase → throws
    const count = await importSecrets(JSON.parse(json));
    await setState({ enabled: true, salt: blob.salt, at: blob.at || Date.now() });
    await cacheKey(key);
    return { ok: true, count };
  } catch (e) { return { ok: false, reason: 'bad-passphrase' }; }
}

// UI status: is there a remote vault? is it enabled on this device? unlocked this session?
export async function vaultStatus() {
  const [blob, st, key] = await Promise.all([getSecretsBlob().catch(() => null), getState(), cachedKey()]);
  return { remote: !!(blob && blob.salt), enabled: !!st.enabled, unlocked: !!key, remoteAt: blob && blob.at, localAt: st.at };
}
