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

// A month-SHARDED source round-trips through the WebDAV backend: saveSource splits into <id>/<YYYY-MM>.json,
// loadSource reassembles via a PROPFIND listing. Mock is a URL-keyed file tree that answers PUT/GET/DELETE/
// MKCOL/PROPFIND, so listShardNames actually finds the shards that were written.
test('webdav store round-trips a sharded source (save → load), id with ":" preserved', async () => {
  const files = {};
  globalThis.fetch = async (url, init = {}) => {
    const m = init.method || 'GET';
    if (m === 'PUT') { files[url] = typeof init.body === 'string' ? init.body : await init.body.text(); return { ok: true, status: 201 }; }
    if (m === 'GET') return files[url] != null ? { ok: true, status: 200, json: async () => JSON.parse(files[url]) } : { ok: false, status: 404 };
    if (m === 'DELETE') { const pre = url.replace(/\/$/, '') + '/'; for (const k of Object.keys(files)) if (k === url || k.startsWith(pre)) delete files[k]; return { ok: true, status: 204 }; }
    if (m === 'MKCOL') return { ok: true, status: 201 };
    if (m === 'PROPFIND') {
      const dir = url.replace(/\/$/, ''); const self = new URL(dir).pathname; const kids = new Map();
      for (const k of Object.keys(files)) if (k.startsWith(dir + '/')) { const rest = k.slice(dir.length + 1); kids.set(rest.split('/')[0], rest.includes('/')); }
      let xml = `<response><href>${self}/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>`;
      for (const [seg, isDir] of kids) xml += `<response><href>${new URL(dir + '/' + seg).pathname}${isDir ? '/' : ''}</href><propstat><prop><resourcetype>${isDir ? '<collection/>' : ''}</resourcetype></prop></propstat></response>`;
      return { ok: true, status: 207, text: async () => `<multistatus>${xml}</multistatus>` };
    }
    return { ok: true, status: 201 };
  };
  const b = await wd.make({ sinkId: 'dav' });
  await b.saveSource('wizink-es:movimientos', { meta: { source: 'wizink-es' }, items: { A1: { record: { internalId: 'A1', date: '2025-01-15' }, at: 1 } } });
  const back = await b.loadSource('wizink-es:movimientos');
  assert.deepEqual(back.items.A1.record, { internalId: 'A1', date: '2025-01-15' }, 'the record round-trips through the shard');
  assert.deepEqual(await b.listSources(), ['wizink-es:movimientos'], 'the ":" id is preserved');
  assert.equal(await b.loadSource('missing'), null);
  delete globalThis.fetch;
});

// Same for S3: shards are objects under a key prefix; listShardNames uses a delimiter listing (ListObjectsV2).
test('s3 store round-trips a sharded source via SigV4-signed PUT/GET + delimiter listing', async () => {
  const store = {};
  const keyOf = (u) => u.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const m = init.method || 'GET';
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || ''; const delim = u.searchParams.get('delimiter');
      const dirs = new Set(); let xml = '<ListBucketResult>';
      for (const k of Object.keys(store)) { if (!k.startsWith(prefix)) continue; const rest = k.slice(prefix.length); if (delim && rest.includes('/')) dirs.add(prefix + rest.split('/')[0] + '/'); else xml += `<Contents><Key>${k}</Key></Contents>`; }
      for (const p of dirs) xml += `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`;
      return { ok: true, status: 200, text: async () => xml + '</ListBucketResult>' };
    }
    const key = keyOf(u);
    if (m === 'PUT') { store[key] = init.body ? Buffer.from(init.body).toString('utf8') : ''; return { ok: true, status: 200, text: async () => '' }; }
    if (m === 'DELETE') { delete store[key]; return { ok: true, status: 204, text: async () => '' }; }
    return store[key] != null ? { ok: true, status: 200, json: async () => JSON.parse(store[key]) } : { ok: false, status: 404, text: async () => '' };
  };
  const b = await s3.make({ sinkId: 's3x' });
  await b.saveSource('src', { items: { A1: { record: { internalId: 'A1', date: '2025-06-01' }, at: 1 } } });
  const back = await b.loadSource('src');
  assert.deepEqual(back.items.A1.record, { internalId: 'A1', date: '2025-06-01' });
  assert.deepEqual(await b.listSources(), ['src']);
  delete globalThis.fetch;
});
