import { test } from 'node:test';
import assert from 'node:assert/strict';

// Reading a delivered FILE back out of Drive is what lets an archive move to a new destination without
// asking the service for it again — which for many services is not possible at all (Carrefour answers
// 406 for old tickets). Drive is addressed by id rather than by path, so this is the one origin that
// needs a name lookup, and the one that can go wrong in a way the others cannot: ensureFolderPath, the
// writer's helper, CREATES folders it does not find. A reader must never do that.

const now = Date.now();
globalThis.chrome = { storage: { local: { get: async (k) => ({ [k]: { token: 'T', expiresAt: now + 1e6 } }) } } };

// Minimal fake Drive: folders + files addressed the way drive.js addresses them.
function fakeDrive({ folders = [], files = [] } = {}) {
  const F = new Map([['root', { name: 'root', parent: null }]]);
  const B = new Map();
  let seq = 1;
  for (const path of folders) {
    let parent = 'root';
    for (const name of path.split('/').filter(Boolean)) {
      let id = [...F].find(([, o]) => o.parent === parent && o.name === name)?.[0];
      if (!id) { id = 'f' + seq++; F.set(id, { name, parent }); }
      parent = id;
    }
  }
  const idOfPath = (path) => {
    let parent = 'root';
    for (const name of path.split('/').filter(Boolean)) {
      const hit = [...F].find(([, o]) => o.parent === parent && o.name === name);
      if (!hit) return null;
      parent = hit[0];
    }
    return parent;
  };
  for (const { path, name, body } of files) B.set('b' + seq++, { parent: idOfPath(path), name, body });

  const created = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (method === 'POST') { created.push(JSON.parse(init.body || '{}').name); return ok({ id: 'new' + seq++ }); }
    const media = /\/files\/([^?]+)\?alt=media/.exec(u.pathname + u.search);
    if (media) {
      const f = B.get(media[1]);
      if (!f) return { ok: false, status: 404 };
      return { ok: true, status: 200, blob: async () => ({ _body: f.body, size: f.body.length }) };
    }
    const q = u.searchParams.get('q') || '';
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const wantFolder = /mimeType='application\/vnd\.google-apps\.folder'/.test(q);
    const byName = /name='([^']+)'/.exec(q)?.[1];
    let hits = [];
    if (wantFolder || byName) {
      for (const [id, o] of F) if (o.parent === parent && (!byName || o.name === byName)) hits.push({ id, name: o.name });
      if (!wantFolder) for (const [id, o] of B) if (o.parent === parent && (!byName || o.name === byName)) hits.push({ id, name: o.name });
      if (wantFolder) hits = hits.filter((h) => [...F].some(([id]) => id === h.id));
    } else {
      for (const [id, o] of B) if (o.parent === parent) hits.push({ id, name: o.name });
    }
    return ok({ files: hits });
  };
  return { created };
}

const SINK = { type: 'drive', id: 'd1', clientId: 'test', rootFolderName: 'Habeas' };

test('a delivered file is read back from the path it was written to', async () => {
  fakeDrive({ folders: ['Habeas/carrefour'], files: [{ path: 'Habeas/carrefour', name: 'abc.pdf', body: 'PDF-BYTES' }] });
  const { driveRetrieve } = await import('../src/sinks/drive.js?case=hit');
  const blob = await driveRetrieve(SINK, 'carrefour/abc.pdf');
  assert.ok(blob, 'expected the file back');
  assert.equal(blob._body, 'PDF-BYTES');
});

test('a missing file yields null rather than an error', async () => {
  fakeDrive({ folders: ['Habeas/carrefour'] });
  const { driveRetrieve } = await import('../src/sinks/drive.js?case=miss');
  assert.equal(await driveRetrieve(SINK, 'carrefour/nope.pdf'), null);
});

test('reading NEVER creates a folder, however deep the path is missing', async () => {
  // ensureFolderPath (the writer's helper) makes what it cannot find. If retrieval used it, "copy FROM
  // this destination" would quietly start writing to it — and on a destination the user did not pick.
  const drive = fakeDrive({ folders: ['Habeas'] });
  const { driveRetrieve } = await import('../src/sinks/drive.js?case=nocreate');
  assert.equal(await driveRetrieve(SINK, 'nowhere/deep/abc.pdf'), null);
  assert.deepEqual(drive.created, [], `retrieval created: ${drive.created.join(', ')}`);
});

test('one folder listing serves many files from that folder', async () => {
  // Drive costs a lookup per name; without the cache a few thousand documents is rate-limit territory.
  fakeDrive({ folders: ['Habeas/dia'], files: [
    { path: 'Habeas/dia', name: 'a.pdf', body: 'A' },
    { path: 'Habeas/dia', name: 'b.pdf', body: 'B' },
    { path: 'Habeas/dia', name: 'c.pdf', body: 'C' },
  ] });
  const { driveRetrieve, driveCache } = await import('../src/sinks/drive.js?case=cache');
  const cache = driveCache();
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (...a) => { calls++; return real(...a); };
  for (const n of ['a', 'b', 'c']) assert.ok(await driveRetrieve(SINK, `dia/${n}.pdf`, { cache }));
  // 2 folder lookups (Habeas, dia) + 1 listing, then a download each: without the cache it would be
  // three lookups and three listings on top.
  assert.ok(calls <= 7, `expected the cache to hold; made ${calls} requests`);
});
