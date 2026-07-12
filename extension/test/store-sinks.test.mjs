// Canonical-store backends over the delivery sinks (Dropbox / WebDAV / S3): each resolves a configured
// sink of its type (by sinkId) and reuses its credentials. Stubs storage.local (config) and mocks fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = {
  'habeas:config': {
    sinks: [
      { id: 'dav', type: 'webdav', url: 'https://dav.example.com/Habeas', username: 'me' },
      { id: 's3x', type: 's3', bucket: 'b', region: 'eu-west-1', accessKeyId: 'AK' },
      { id: 'dbx', type: 'dropbox', appKey: 'K' },
    ],
  },
};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k == null ? { ...LOCAL } : { [k]: LOCAL[k] }),
  set: async (o) => Object.assign(LOCAL, o),
  remove: async (k) => { delete LOCAL[k]; },
} } };

const wd = await import('../src/lib/store/webdav.js');
const s3 = await import('../src/lib/store/s3.js');
const dbx = await import('../src/lib/store/dropbox.js');

test('every store backend exposes { loadSource, saveSource, listSources }', async () => {
  for (const [m, cfg] of [[wd, { sinkId: 'dav' }], [s3, { sinkId: 's3x' }], [dbx, { sinkId: 'dbx' }]]) {
    const b = await m.make(cfg);
    assert.equal(typeof b.loadSource, 'function');
    assert.equal(typeof b.saveSource, 'function');
    assert.equal(typeof b.listSources, 'function');
  }
});

test('store make throws when no sink of that type is configured', async () => {
  await assert.rejects(() => wd.make({ sinkId: 'nope' }), /WebDAV sink/);
  await assert.rejects(() => s3.make({ sinkId: 'nope' }), /S3 sink/);
});

test('webdav store round-trips a source object (save → load), id with ":" preserved', async () => {
  const store = {};
  globalThis.fetch = async (url, init = {}) => {
    const m = init.method || 'GET';
    if (m === 'PUT') { store[url] = typeof init.body === 'string' ? init.body : await init.body.text(); return { ok: true, status: 201 }; }
    if (m === 'GET') return store[url] != null ? { ok: true, status: 200, json: async () => JSON.parse(store[url]) } : { ok: false, status: 404 };
    return { ok: true, status: 201 }; // MKCOL
  };
  const b = await wd.make({ sinkId: 'dav' });
  const data = { items: { A1: { record: { internalId: 'A1' } } } };
  await b.saveSource('wizink-es:movimientos', data);
  assert.deepEqual(await b.loadSource('wizink-es:movimientos'), data);
  assert.equal(await b.loadSource('missing'), null);
  delete globalThis.fetch;
});

test('s3 store round-trips a source object via SigV4-signed PUT/GET', async () => {
  const store = {};
  globalThis.fetch = async (url, init = {}) => {
    const key = url.split('?')[0];
    const m = init.method || 'GET';
    if (m === 'PUT') { store[key] = init.body ? Buffer.from(init.body).toString('utf8') : ''; return { ok: true, status: 200, text: async () => '' }; }
    return store[key] != null ? { ok: true, status: 200, json: async () => JSON.parse(store[key]) } : { ok: false, status: 404, text: async () => '' };
  };
  const b = await s3.make({ sinkId: 's3x' });
  const data = { items: { A1: {} } };
  await b.saveSource('src', data);
  assert.deepEqual(await b.loadSource('src'), data);
  delete globalThis.fetch;
});
