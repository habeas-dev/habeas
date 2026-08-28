// Persist File System Access directory handles (chosen when configuring a local-folder
// sink) in IndexedDB — they are not serializable to chrome.storage. Reused at send time,
// re-verifying permission (which normally persists once granted).
const DB = 'habeas';
const STORE = 'handles';

// indexedDB.open has THREE outcomes, not two. Besides onsuccess and onerror there is onblocked, fired when
// the open needs a version upgrade and another connection still holds the database — and after it, neither
// of the other two ever fires. Left unhandled, the promise never settled and everything awaiting it waited
// for ever, with no error to report and nothing in any log.
//
// It shows up on one browser and not the other for a reason that is pure accident: a folder destination is
// picked in Chrome, so the database exists there and no open ever needs an upgrade. The same destination
// then arrives in Firefox through config sync, where the database has never been created — so the first
// open there IS an upgrade, and an upgrade is the only kind that can block.
const OPEN_TIMEOUT_MS = 5000;
function open(opts = {}) {
  const limit = opts.timeoutMs || OPEN_TIMEOUT_MS;
  return new Promise((res, rej) => {
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => finish(rej, new Error('indexedDB open timed out after ' + Math.round(limit / 1000) + 's')), limit);
    let r;
    try { r = indexedDB.open(DB, 1); } catch (e) { finish(rej, e); return; }
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => finish(res, r.result);
    r.onerror = () => finish(rej, r.error);
    // Another connection is holding an older version open. Do not wait on it indefinitely.
    r.onblocked = () => finish(rej, new Error('indexedDB open blocked by another connection'));
  });
}
export async function putHandle(key, handle) {
  const db = await open();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } finally { try { db.close(); } catch (e) {} } // leaving it open is what blocks the next upgrade
}
export async function getHandle(key, opts) {
  const db = await open(opts);
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  } finally { try { db.close(); } catch (e) {} }
}
export async function verifyPermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}
