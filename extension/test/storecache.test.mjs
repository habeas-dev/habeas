import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, isUsable, MAX_AGE_MS } from '../src/lib/storecache.js';

// A read-through cache of the canonical store, so opening a source in the Archive paints the documents
// you saw last time instead of a spinner while Dropbox is fetched. Display only — see the note in the
// module about why this must never feed a write path.

test('a cache key is the store key, namespaced per backend', () => {
  // The same source can live in two different backends (a local store and a Dropbox one). Sharing one
  // entry between them would show a device the other backend's documents.
  assert.notEqual(cacheKey('dropbox', 'ing-es:movimientos'), cacheKey('local', 'ing-es:movimientos'));
  assert.equal(cacheKey('dropbox', 'ing-es:movimientos'), cacheKey('dropbox', 'ing-es:movimientos'));
});

test('a missing or malformed entry is not usable', () => {
  assert.equal(isUsable(null), false);
  assert.equal(isUsable({}), false);
  assert.equal(isUsable({ at: Date.now() }), false, 'no data');
  assert.equal(isUsable({ data: { items: {} } }), false, 'no timestamp');
});

test('a recent entry is usable', () => {
  assert.equal(isUsable({ at: Date.now() - 1000, data: { items: { a: {} } } }), true);
});

test('an entry with no items is still usable — "you have nothing here" is an answer', () => {
  // Painting an empty source instantly is right; making the user wait for Dropbox to confirm emptiness
  // is the bug being fixed.
  assert.equal(isUsable({ at: Date.now(), data: { items: {} } }), true);
});

test('a very old entry is dropped rather than shown', () => {
  // Bounded so a source the user stopped syncing months ago cannot show a stale archive forever.
  assert.equal(isUsable({ at: Date.now() - MAX_AGE_MS - 1, data: { items: { a: {} } } }), false);
  assert.equal(isUsable({ at: Date.now() - MAX_AGE_MS + 60_000, data: { items: { a: {} } } }), true);
});

test('a clock jump into the future does not make an entry immortal', () => {
  assert.equal(isUsable({ at: Date.now() + 86_400_000, data: { items: { a: {} } } }), false);
});

test('the cache is wired for display only, never for writes', async () => {
  // The store's governing invariant is "adopt the remote, never clobber it": a device's local view can
  // never shrink the shared one. A cache IS a stale local view, so letting it decide what to save,
  // delete or mark delivered would be that data-loss bug with extra steps. This pins the boundary.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : (e.name.endsWith('.js') ? [join(dir, e.name)] : []));

  const users = walk(SRC).filter((f) => {
    if (/lib[/\\](store|storecache)\.js$/.test(f)) return false;   // the cache itself and its owner
    return /getSourceCached|storecache/.test(readFileSync(f, 'utf8'));
  });
  const allowed = [/ui[/\\]archive\.js$/];  // draws documents; writes nothing
  const rogue = users.filter((f) => !allowed.some((re) => re.test(f)));
  assert.deepEqual(rogue, [], `cached store reads outside the display layer: ${rogue.join(', ')}`);
});

test('every store write invalidates the cached copy', async () => {
  // A cache that outlives a delete would keep painting documents the user just removed.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const store = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/lib/store.js'), 'utf8');
  for (const fn of ['putItems', 'deleteStoreItems', 'clearStoreSource']) {
    const body = store.slice(store.indexOf(`export async function ${fn}(`));
    assert.match(body.slice(0, 400), /invalidate\(/, `${fn} does not invalidate the cache`);
  }
});
