// A local-folder destination cannot work in Firefox — the File System Access API is Chromium-only — and
// it cannot work in ANY background either, Chrome included: a directory handle belongs to a page. But
// configuration syncs between browsers, so a folder created in Chrome arrives in Firefox intact.
// folderavail.js was written for exactly that and says such a sink is "left out of every operation that
// could only fail". It was wired into the UI alone. The background went on counting it as a readable
// destination: one more sink to walk per source and per output, and an IndexedDB lookup for a handle that
// cannot exist, at every start-up — work that can only ever come back empty.
//
// It matters more than the wasted calls suggest. The unattended startup recovery only records that it has
// finished if it reaches the end; anything that stops it first means it runs again on the next start-up,
// and again after that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sinkUnavailableHere, usableSinks } from '../src/lib/folderavail.js';

const SINKS = [
  { id: 'dbx1', type: 'dropbox' },
  { id: 'folder1', type: 'local-folder', folderName: 'Archivo' },
  { id: 'drv1', type: 'drive' },
];

test('a folder sink is unusable wherever there is no directory picker — every background, both browsers', () => {
  const saved = globalThis.showDirectoryPicker;
  delete globalThis.showDirectoryPicker; // a service worker / event page: no picker, no handles
  try {
    assert.equal(sinkUnavailableHere(SINKS[1]), true);
    assert.deepEqual(usableSinks(SINKS).map((s) => s.id), ['dbx1', 'drv1'],
      'the folder must be left out of the list the background works from');
  } finally { if (saved) globalThis.showDirectoryPicker = saved; }
});

test('in a Chromium page, where it does work, it is kept', () => {
  const saved = globalThis.showDirectoryPicker;
  globalThis.showDirectoryPicker = () => {};
  try {
    assert.equal(sinkUnavailableHere(SINKS[1]), false);
    assert.deepEqual(usableSinks(SINKS).map((s) => s.id), ['dbx1', 'folder1', 'drv1'],
      'a folder destination that works must not be dropped');
  } finally { if (saved) globalThis.showDirectoryPicker = saved; else delete globalThis.showDirectoryPicker; }
});

test('nothing else is ever filtered out — this is about folders, not about tidying the config', () => {
  const saved = globalThis.showDirectoryPicker;
  delete globalThis.showDirectoryPicker;
  try {
    const all = [{ id: 'a', type: 'http' }, { id: 'b', type: 's3' }, { id: 'c', type: 'download' }, { id: 'd', type: 'email' }];
    assert.deepEqual(usableSinks(all).map((s) => s.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(usableSinks([]), []);
    assert.deepEqual(usableSinks(undefined), []);
  } finally { if (saved) globalThis.showDirectoryPicker = saved; }
});

test('the background actually applies the guard where it walks destinations', () => {
  // Asserted against the source because these are the call sites that walk EVERY configured destination:
  // the startup recovery, the per-source reconcile, and the send that reads a file back from another
  // destination before asking the service for it.

  const bg = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const guarded = (bg.match(/usableSinks\(cfg\.sinks\)/g) || []).length;
  assert.ok(guarded >= 3, `the startup recovery, the reconcile and the send must all be guarded (found ${guarded})`);
  const raw = bg.split('\n').filter((l) => /\(cfg\.sinks \|\| \[\]\)\.filter/.test(l));
  assert.deepEqual(raw, [], 'no walk over configured destinations may skip the guard:\n  ' + raw.join('\n  '));
});

test('retrieval skips an unusable folder before it opens a database', async () => {
  // retrieveDelivered runs once per document — the Archive's format scan walks a whole archive with it. On
  // a browser where folder destinations cannot work, each of those was an IndexedDB open for a handle that
  // cannot exist, and before the connection was closed after use, each one also leaked a connection.
  const saved = globalThis.showDirectoryPicker;
  delete globalThis.showDirectoryPicker;
  let opened = 0;
  globalThis.indexedDB = { open() { opened++; const r = {}; setTimeout(() => r.onerror && r.onerror()); return r; } };
  try {
    const { retrieveDelivered } = await import('../src/lib/retrieve.js');
    const adapter = { id: 'wizink-es', service: 'wizink', api: { host: 'x.invalid', pdf: { path: '/p' } } };
    for (let i = 0; i < 25; i++) {
      const r = await retrieveDelivered({ id: 'folder1', type: 'local-folder' }, adapter, { internalId: 'd' + i, date: '2025-03-01' }, 'pdf', { only: true });
      assert.equal(r.blob, undefined);
    }
    assert.equal(opened, 0, `no database may be opened for a destination this browser cannot use (opened ${opened})`);
  } finally { if (saved) globalThis.showDirectoryPicker = saved; }
});
