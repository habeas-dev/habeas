// The canonical-store dispatch imports ./store/drive.js for backend:'drive'. Before, that file was missing
// so selecting Drive as the store backend threw. Assert the module resolves and exposes the backend shape
// { loadSource, saveSource, listSources } — and that ids keep their ":" (Drive allows it; stream keys like
// "wizink-es:movimientos" must round-trip through listSources()).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ext.js captures globalThis.chrome at import time → stub it BEFORE importing the module (dynamic import).
const now = Date.now();
globalThis.chrome = { storage: { session: { get: async (k) => ({ [k]: { token: 'T', expiresAt: now + 1e6 } }) } } };
const { make } = await import('../src/lib/store/drive.js');

test('drive store backend exposes the { loadSource, saveSource, listSources } interface', () => {
  const b = make({ clientId: 'test', interactive: false });
  assert.equal(typeof b.loadSource, 'function');
  assert.equal(typeof b.saveSource, 'function');
  assert.equal(typeof b.listSources, 'function');
});

test('drive store backend round-trips a source id with a ":" (stream key) via a faked Drive REST layer', async () => {
  // Fake Drive: an in-memory tree of folders + files, driven by the same REST endpoints drive.js calls.
  const folders = new Map([['root', { name: 'root', parent: null }]]); // id → {name,parent}
  const files = new Map(); // id → {name, parent, body}
  let seq = 1;
  const idFor = () => 'id' + (seq++);
  const childByName = (parent, name, folder) => {
    const src = folder ? folders : files;
    for (const [id, o] of src) if (o.parent === parent && o.name === name) return id;
    return null;
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname === '/drive/v3/files' && (!init.method || init.method === 'GET')) {
      const q = decodeURIComponent(u.searchParams.get('q') || '');
      const parent = (q.match(/'([^']+)' in parents/) || [])[1];
      const nameM = q.match(/name='([^']*)'/);
      const wantFolder = /application\/vnd\.google-apps\.folder'/.test(q) && !/mimeType!=/.test(q);
      if (nameM) { const id = childByName(parent, nameM[1], wantFolder); return ok({ files: id ? [{ id, name: nameM[1] }] : [] }); }
      // listFolderJson: non-folder children of parent
      const out = [...files].filter(([, o]) => o.parent === parent).map(([, o]) => ({ name: o.name }));
      return ok({ files: out });
    }
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') { const b = JSON.parse(init.body); const id = idFor(); folders.set(id, { name: b.name, parent: b.parents[0] }); return ok({ id }); }
    if (u.pathname === '/upload/drive/v3/files') { // multipart create (used by putJson when file is new)
      const text = await init.body.text(); const nameM = text.match(/"name":"([^"]+)"/); const parentM = text.match(/"parents":\["([^"]+)"\]/);
      const body = text.slice(text.lastIndexOf('\r\n\r\n') + 4, text.lastIndexOf('\r\n--'));
      files.set(idFor(), { name: nameM[1], parent: parentM[1], body }); return ok({ id: 'x' });
    }
    if (u.pathname.startsWith('/drive/v3/files/') && u.searchParams.get('alt') === 'media') { const id = u.pathname.split('/').pop(); return ok(JSON.parse(files.get(id).body)); }
    throw new Error('unexpected ' + init.method + ' ' + u.pathname);
  };

  const b = make({ clientId: 'test', interactive: false });
  const data = { meta: { source: 'wizink-es' }, items: { 'x|1': { record: { internalId: 'x|1' }, at: 1 } } };
  await b.saveSource('wizink-es:movimientos', data);
  const back = await b.loadSource('wizink-es:movimientos');
  assert.deepEqual(back, data, 'store object round-trips');
  const ids = await b.listSources();
  assert.deepEqual(ids, ['wizink-es:movimientos'], 'the ":" id is preserved (no sanitize on Drive)');
});
