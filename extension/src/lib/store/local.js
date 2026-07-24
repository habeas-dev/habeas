// Canonical store — LOCAL backend (IndexedDB), the default single-device host. Month-SHARDED like the file
// backends, but over IDB keys instead of files: a shard is the key `<sourceId>/<name>` and the pre-shard blob
// is the bare key `<sourceId>` (auto-reformatted on load). Its own database, keyed access, no concurrency
// guard (single instance). See lib/store/sharded.js for the shard/period logic.
import { makeShardedStore } from './sharded.js';

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
const idbGet = async (key) => { const db = await open(); return new Promise((res, rej) => { const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(key); q.onsuccess = () => res(q.result != null ? q.result : null); q.onerror = () => rej(q.error); }); };
const idbPut = async (key, val) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(val, key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };
const idbDel = async (key) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(key); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };
const idbKeys = async () => { const db = await open(); return new Promise((res, rej) => { const q = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(); q.onsuccess = () => res((q.result || []).map(String)); q.onerror = () => rej(q.error); }); };

const shardKey = (id, name) => id + '/' + name;
// Sharded prim over IDB keys. A source id never contains '/', so `<id>/` is an unambiguous shard prefix.
const prim = {
  readShard: (id, name) => idbGet(shardKey(id, name)),
  writeShard: (id, name, obj) => idbPut(shardKey(id, name), obj),
  removeShard: (id, name) => idbDel(shardKey(id, name)),
  async listShardNames(id) { const pre = id + '/'; return (await idbKeys()).filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)).filter((n) => n !== '_meta'); },
  async listSourceIds() { const s = new Set(); for (const k of await idbKeys()) { const i = k.indexOf('/'); s.add(i === -1 ? k : k.slice(0, i)); } return [...s]; },
  readLegacy: (id) => idbGet(id),        // the pre-shard single blob lives at the bare source-id key
  removeLegacy: (id) => idbDel(id),
  async removeSource(id) { const pre = id + '/'; for (const k of await idbKeys()) if (k === id || k.startsWith(pre)) await idbDel(k); },
};

const backend = makeShardedStore(prim);
export const loadSource = backend.loadSource;
export const saveSource = backend.saveSource;
export const appendItems = backend.appendItems;
export const listSources = backend.listSources;
export const clearSource = backend.clearSource;
export const hasItems = backend.hasItems;
export const getConfig = backend.getConfig;
export const putConfig = backend.putConfig;
