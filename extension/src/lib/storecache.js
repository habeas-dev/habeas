// A read-through cache of the canonical store, so opening a source in the Archive paints the documents
// you saw last time INSTEAD of a spinner while a cloud backend is fetched. Dropbox for a bank source is
// several sharded requests; staring at "Loading" for data that has not changed since this morning is the
// problem this exists to remove.
//
// DISPLAY ONLY. This must never feed a write path. The store's governing invariant is "adopt the remote,
// never clobber it" — a device's local view can never shrink the shared one — and a cache is by
// definition a stale local view. Reading it to DRAW is safe; reading it to decide what to save, delete
// or mark delivered would be exactly the data-loss bug that invariant exists to prevent.
//
// IndexedDB rather than storage.local: a bank source is thousands of records, and storage.local's quota
// is small and shared with config, ledger and secrets — the things that must never fail to write.
import { chrome } from './ext.js';

const DB = 'habeas-storecache';
const STORE = 'sources';
// A month. Long enough that a source you sync monthly still opens instantly; short enough that one you
// abandoned cannot show you an archive from another era.
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Namespaced per backend: the same source in a local store and a Dropbox one are different archives. */
export function cacheKey(backend, storeKey) {
  return `${backend || 'local'}::${storeKey}`;
}

/** Is this entry worth drawing? Bounded in both directions — a future timestamp is a broken clock. */
export function isUsable(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.at !== 'number' || !entry.data || typeof entry.data !== 'object') return false;
  const age = Date.now() - entry.at;
  return age >= 0 && age <= MAX_AGE_MS;
}

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req && req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

/** The cached payload for a store key, or null. Never throws: a cache miss and a broken cache are the same. */
export async function readCache(backend, storeKey) {
  try {
    const entry = await tx('readonly', (s) => s.get(cacheKey(backend, storeKey)));
    return isUsable(entry) ? entry.data : null;
  } catch (e) { return null; }
}

/** Remember what the store returned. Best-effort — a failed cache write must never fail a real read. */
export async function writeCache(backend, storeKey, data) {
  if (!data || typeof data !== 'object') return;
  try { await tx('readwrite', (s) => s.put({ at: Date.now(), data }, cacheKey(backend, storeKey))); } catch (e) {}
}

/** Forget a source — after a delete, or when the user repoints the store somewhere else. */
export async function dropCache(backend, storeKey) {
  try { await tx('readwrite', (s) => s.delete(cacheKey(backend, storeKey))); } catch (e) {}
}
