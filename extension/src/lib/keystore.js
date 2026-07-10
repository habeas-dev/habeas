// Persists the single non-extractable AES-GCM CryptoKey that encrypts the secrets store.
// Stored in IndexedDB (a CryptoKey is structured-cloneable, unlike chrome.storage which is
// JSON only) as an opaque handle — its raw bytes are never exposed to JS. A dedicated DB
// (not the `habeas` handles DB in fs.js) so the two modules never contend on a version bump.
import { generateSecretKey } from './crypto.js';

const DB = 'habeas-keys';
const STORE = 'k';
const KEY_ID = 'secrets';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function get(key) {
  return open().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).get(key);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  }));
}
function put(key, val) {
  return open().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}

// The key, minted once on first use and reused thereafter.
export async function getOrCreateSecretKey() {
  const existing = await get(KEY_ID);
  if (existing) return existing;
  const key = await generateSecretKey();
  await put(KEY_ID, key);
  return key;
}
