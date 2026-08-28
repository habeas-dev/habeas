// getHandle() is the only place a folder destination is looked up, and it opens IndexedDB to do it.
// indexedDB.open resolves through onsuccess or onerror — but a THIRD outcome exists: onblocked, fired when
// the open needs a version upgrade and another connection is still holding the database. Nothing handled
// it, and nothing closed a connection once opened, so a blocked open settled neither way: the promise
// never resolved, and whatever awaited it waited for ever.
//
// It is browser-specific by accident of history. A folder destination is picked in Chrome, so the database
// exists there and no open ever needs an upgrade. That same destination then arrives in Firefox by config
// sync, where the database has never been created — so the first open there is an upgrade, and an upgrade
// is the one kind that can block.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A fake indexedDB whose open() does whatever the test asks: succeed, fail, or block and never settle.
function fakeIDB(mode) {
  const closed = [];
  globalThis.indexedDB = { open() {
    const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null, error: null };
    setTimeout(() => {
      if (mode === 'blocked') { if (req.onblocked) req.onblocked(); return; } // …and then nothing, ever
      if (mode === 'error') { req.error = new Error('idb refused'); if (req.onerror) req.onerror(); return; }
      req.result = {
        close: () => closed.push(1),
        transaction: () => ({
          objectStore: () => ({ get: () => { const r = { onsuccess: null, onerror: null, result: null }; setTimeout(() => r.onsuccess && r.onsuccess()); return r; } }),
        }),
      };
      if (req.onupgradeneeded) { req.result.createObjectStore = () => {}; req.onupgradeneeded(); }
      if (req.onsuccess) req.onsuccess();
    }, 1);
    return req;
  } };
  return { closed };
}

const withTimeout = (p, ms) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('HUNG'), ms))]);

test('a blocked open does not hang for ever', async () => {
  fakeIDB('blocked');
  const { getHandle } = await import('../src/lib/fs.js?case=blocked');
  assert.equal(await withTimeout(getHandle('dir:x', { timeoutMs: 60 }), 400), 'settled',
    'a blocked open must settle — the whole operation waits on this one promise');
});

test('and it settles as "no handle", not as a crash the caller cannot read', async () => {
  fakeIDB('blocked');
  const { getHandle } = await import('../src/lib/fs.js?case=blocked2');
  const r = await getHandle('dir:x', { timeoutMs: 60 }).catch(() => 'threw');
  assert.ok(r === null || r === 'threw', 'either is fine; hanging is not');
});

test('a normal open still works, and closes the connection it opened', async () => {
  const { closed } = fakeIDB('ok');
  const { getHandle } = await import('../src/lib/fs.js?case=ok');
  assert.equal(await getHandle('dir:x'), null, 'no handle stored → null');
  assert.ok(closed.length >= 1, 'the connection must be closed — an unclosed one is what blocks the NEXT upgrade');
});

test('a real open error is still an error', async () => {
  fakeIDB('error');
  const { getHandle } = await import('../src/lib/fs.js?case=err');
  await assert.rejects(() => getHandle('dir:x'));
});
