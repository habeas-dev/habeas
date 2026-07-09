// Canonical store — LOCAL backend (IndexedDB), the default single-device host. Its own database (separate
// from lib/fs.js's handle store) keyed by sourceId → { meta, items }. Store-capable + readable-back; no
// concurrency guard needed (single instance). Cloud backends (folder/drive/http) come in a later phase.
const DB = 'habeas-store';
const STORE = 'sources';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const tx = (db, mode) => db.transaction(STORE, mode).objectStore(STORE);

export async function loadSource(sourceId) {
  const db = await open();
  return new Promise((res, rej) => { const q = tx(db, 'readonly').get(sourceId); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); });
}
export async function saveSource(sourceId, data) {
  const db = await open();
  return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(data, sourceId); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
export async function listSources() {
  const db = await open();
  return new Promise((res, rej) => { const q = tx(db, 'readonly').getAllKeys(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
}
export async function clearSource(sourceId) {
  const db = await open();
  return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(sourceId); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}
