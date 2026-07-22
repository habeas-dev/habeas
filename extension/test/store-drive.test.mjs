// The canonical-store dispatch imports ./store/drive.js for backend:'drive'. Before, that file was missing
// so selecting Drive as the store backend threw. Assert the module resolves and exposes the backend shape
// { loadSource, saveSource, listSources } — and that ids keep their ":" (Drive allows it; stream keys like
// "wizink-es:movimientos" must round-trip through listSources()).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ext.js captures globalThis.chrome at import time → stub it BEFORE importing the module (dynamic import).
// The Drive token is now cached in storage.local (survives browser restart → no re-prompt every open).
const now = Date.now();
globalThis.chrome = { storage: { local: { get: async (k) => ({ [k]: { token: 'T', expiresAt: now + 1e6 } }) } } };
const { make } = await import('../src/lib/store/drive.js');

test('drive store backend exposes the { loadSource, saveSource, listSources } interface', () => {
  const b = make({ clientId: 'test', interactive: false });
  assert.equal(typeof b.loadSource, 'function');
  assert.equal(typeof b.saveSource, 'function');
  assert.equal(typeof b.listSources, 'function');
});

test('drive store round-trips a sharded source id with a ":" (stream key) via a faked Drive REST layer', async () => {
  // Fake Drive: an in-memory tree of folders + files, driven by the same REST endpoints drive.js calls
  // (now including folder-per-source, PATCH updates, DELETE, and name+mimeType listings for listSourceEntries).
  const folders = new Map([['root', { name: 'root', parent: null }]]); // id → {name,parent}
  const files = new Map(); // id → {name, parent, body}
  let seq = 1; const idFor = () => 'id' + (seq++);
  const childByName = (parent, name, folder) => { const src = folder ? folders : files; for (const [id, o] of src) if (o.parent === parent && o.name === name) return id; return null; };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET';
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = decodeURIComponent(u.searchParams.get('q') || ''); const parent = (q.match(/'([^']+)' in parents/) || [])[1];
      const nameM = q.match(/name='([^']*)'/); const wantFolder = /mimeType='application\/vnd\.google-apps\.folder'/.test(q);
      const fields = u.searchParams.get('fields') || '';
      if (nameM) { const id = childByName(parent, nameM[1], wantFolder); return ok({ files: id ? [{ id, name: nameM[1] }] : [] }); }
      if (/mimeType/.test(fields)) { // listSourceEntries: folders + files with mimeType
        const out = [];
        for (const [, o] of folders) if (o.parent === parent) out.push({ name: o.name, mimeType: 'application/vnd.google-apps.folder' });
        for (const [, o] of files) if (o.parent === parent) out.push({ name: o.name, mimeType: 'application/json' });
        return ok({ files: out });
      }
      return ok({ files: [...files].filter(([, o]) => o.parent === parent).map(([, o]) => ({ name: o.name })) }); // listFolderJson
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') { const b = JSON.parse(init.body); const id = idFor(); folders.set(id, { name: b.name, parent: b.parents[0] }); return ok({ id }); }
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') { const text = await init.body.text(); const nameM = text.match(/"name":"([^"]+)"/); const parentM = text.match(/"parents":\["([^"]+)"\]/); const body = text.slice(text.lastIndexOf('\r\n\r\n') + 4, text.lastIndexOf('\r\n--')); files.set(idFor(), { name: nameM[1], parent: parentM[1], body }); return ok({ id: 'x' }); }
    if (u.pathname.startsWith('/upload/drive/v3/files/') && method === 'PATCH') { const id = u.pathname.split('/').pop(); const body = typeof init.body === 'string' ? init.body : await init.body.text(); if (files.has(id)) files.get(id).body = body; return ok({ id }); }
    if (u.pathname.startsWith('/drive/v3/files/') && u.searchParams.get('alt') === 'media') { return ok(JSON.parse(files.get(u.pathname.split('/').pop()).body)); }
    if (u.pathname.startsWith('/drive/v3/files/') && method === 'DELETE') { const id = u.pathname.split('/').pop(); files.delete(id); folders.delete(id); return { ok: true, status: 204 }; }
    throw new Error('unexpected ' + method + ' ' + u.pathname);
  };

  const b = make({ clientId: 'test', interactive: false });
  await b.saveSource('wizink-es:movimientos', { meta: { source: 'wizink-es' }, items: { 'x|1': { record: { internalId: 'x|1', date: '2025-03-04' }, at: 1 } } });
  const back = await b.loadSource('wizink-es:movimientos');
  assert.deepEqual(back.items['x|1'].record, { internalId: 'x|1', date: '2025-03-04' }, 'the record round-trips through the shard');
  assert.deepEqual(back.meta, { source: 'wizink-es' }, 'source meta is preserved in _meta');
  assert.deepEqual(await b.listSources(), ['wizink-es:movimientos'], 'the ":" id is preserved (no sanitize on Drive)');
});
