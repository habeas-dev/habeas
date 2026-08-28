// A send reads each document back from every OTHER configured store before asking the source for it
// (the "prefer stored over source" rule). On Dropbox that was one files/download PER DOCUMENT, in
// series — the whole file pulled over the wire to answer "is it there?". An archive that grows past a
// few hundred documents then never finishes the pass, and the UI sits on "Listing…" with no error,
// which is exactly how a working source looked broken for four days.
//
// Drive already solved this: driveCache() turns N lookups into one folder listing. Dropbox needs the
// same — one recursive list_folder per service folder, and a download ONLY for a path the listing says
// is actually there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from '../src/lib/crypto.js';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k == null ? { ...LOCAL } : { [k]: LOCAL[k] }),
  set: async (o) => { Object.assign(LOCAL, o); },
  remove: async (k) => { delete LOCAL[k]; },
} } };

const { _setKeyProvider, encryptString } = await import('../src/lib/secrets.js');
const KEY = await generateSecretKey();
_setKeyProvider(async () => KEY);

const { retrieveDelivered } = await import('../src/lib/retrieve.js');
const { dropboxCache } = await import('../src/sinks/dropbox.js');

const SINK = { id: 'dbx1', type: 'dropbox', rootFolderName: 'Habeas' };
const ADAPTER = { id: 'wizink-es', service: 'wizink', schema: 'transaction', api: { host: 'example.invalid', pdf: { path: '/d/{id}' } } };

// Only these three documents were ever delivered; the rest of the archive lives somewhere else.
const PRESENT = [
  '/habeas/wizink/2025/2025-03-04-a1.pdf',
  '/habeas/wizink/2025/2025-03-11-a2.pdf',
  '/habeas/wizink/2024/2024-11-02-a3.pdf',
];

function mockDbx() {
  const calls = { list: 0, download: 0, meta: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const arg = init.headers && init.headers['Dropbox-API-Arg'];
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (u.includes('/2/files/list_folder')) {
      calls.list++;
      const root = String((body && body.path) || '').toLowerCase().replace(/\/+$/, '');
      const under = PRESENT.filter((p) => p.startsWith(root + '/'));
      if (!under.length) return { ok: false, status: 409, json: async () => ({ error_summary: 'path/not_found' }), text: async () => 'path/not_found' };
      return { ok: true, status: 200, json: async () => ({
        entries: under.map((p) => ({ '.tag': 'file', name: p.split('/').pop(), path_lower: p })),
        has_more: false, cursor: '',
      }) };
    }
    if (u.includes('/2/files/download')) {
      calls.download++;
      const p = JSON.parse(arg).path.toLowerCase();
      if (!PRESENT.includes(p)) return { ok: false, status: 409, text: async () => 'path/not_found' };
      return { ok: true, status: 200, blob: async () => ({ size: 4, _p: p }) };
    }
    if (u.includes('/2/files/get_metadata')) {
      calls.meta++;
      const p = String(body.path).toLowerCase();
      if (!PRESENT.includes(p)) return { ok: false, status: 409, text: async () => 'path/not_found' };
      return { ok: true, status: 200, json: async () => ({ name: p.split('/').pop() }) };
    }
    throw new Error('unexpected fetch ' + u);
  };
  return calls;
}

// 40 documents in the archive, 3 of them delivered here — the shape of a real WiZink run.
const DOCS = [
  { internalId: 'a1', date: '2025-03-04' }, { internalId: 'a2', date: '2025-03-11' }, { internalId: 'a3', date: '2024-11-02' },
  ...Array.from({ length: 37 }, (_, i) => ({ internalId: 'z' + i, date: '2025-0' + (1 + (i % 9)) + '-15' })),
];

test('a cached Dropbox retrieval never downloads a file to discover it is not there', async () => {
  LOCAL['dbx:dbx1'] = { tokenEnc: await encryptString('T'), expiresAt: Date.now() + 1e6 };
  const calls = mockDbx();
  const cache = dropboxCache();
  const got = [];
  for (const d of DOCS) {
    const r = await retrieveDelivered(SINK, ADAPTER, d, 'pdf', { only: true, dropboxCache: cache });
    if (r && r.blob) got.push(d.internalId);
  }
  assert.deepEqual(got, ['a1', 'a2', 'a3'], 'the three delivered documents must still come back');
  assert.equal(calls.download, 3, `only present files may be downloaded (got ${calls.download} downloads for 40 documents)`);
  assert.ok(calls.list <= 2, `the folder must be listed once, not per document (got ${calls.list} listings)`);
});

test('the same cache serves a second pass without any further listing', async () => {
  LOCAL['dbx:dbx1'] = { tokenEnc: await encryptString('T'), expiresAt: Date.now() + 1e6 };
  const calls = mockDbx();
  const cache = dropboxCache();
  for (const d of DOCS) await retrieveDelivered(SINK, ADAPTER, d, 'pdf', { only: true, dropboxCache: cache });
  const after = calls.list;
  for (const d of DOCS) await retrieveDelivered(SINK, ADAPTER, d, 'pdf', { only: true, dropboxCache: cache });
  assert.equal(calls.list, after, 'the listing is cached for the whole send');
});

test('existence checks answer from the cache with no request at all', async () => {
  LOCAL['dbx:dbx1'] = { tokenEnc: await encryptString('T'), expiresAt: Date.now() + 1e6 };
  const calls = mockDbx();
  const cache = dropboxCache();
  for (const d of DOCS) await retrieveDelivered(SINK, ADAPTER, d, 'pdf', { only: true, existsOnly: true, dropboxCache: cache });
  assert.equal(calls.meta, 0, `a cached existence scan must not call get_metadata per document (got ${calls.meta})`);
  assert.equal(calls.download, 0, 'and must never download');
});
