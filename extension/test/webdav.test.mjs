// WebDAV sink: PUTs each file under the base URL (MKCOL'ing parent collections) with Basic auth, and
// keeps a cumulative per-source manifest (read → merge → write). Mocks fetch; uses no password so the
// secrets store isn't needed (auth header still built from the username).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeToSink } from '../src/sinks/sinks.js';

function mockDav() {
  const calls = [];
  const store = {}; // url -> body text (so the manifest GET reads back what was PUT)
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, auth: init.headers && init.headers.Authorization });
    if (method === 'GET') {
      return store[url] != null
        ? { ok: true, status: 200, json: async () => JSON.parse(store[url]) }
        : { ok: false, status: 404, json: async () => [] };
    }
    if (method === 'PUT') { store[url] = typeof init.body === 'string' ? init.body : await init.body.text(); return { ok: true, status: 201 }; }
    return { ok: true, status: 201 }; // MKCOL
  };
  return { calls, store, restore: () => { delete globalThis.fetch; } };
}

test('webdav: PUTs the file + a manifest with Basic auth, then merges on the next run', async () => {
  const { calls, store, restore } = mockDav();
  const sink = { id: 'dav', type: 'webdav', url: 'https://dav.example.com/Habeas/', username: 'me' };
  const mk = (id, date) => [{ internalId: id, date, total: 5, source: 'demo-es', type: 'receipt' }, new Map([[id, [{ blob: new Blob(['%PDF-1'], { type: 'application/pdf' }), ext: 'pdf' }]]])];

  const [d1, f1] = mk('A1', '2026-01-02');
  const res = await writeToSink(sink, [d1], f1, { service: 'documents', source: 'demo-es' });
  assert.equal(res.written, 1);

  const puts = calls.filter((c) => c.method === 'PUT');
  assert.ok(puts.some((c) => c.url.endsWith('.pdf')), 'a PDF was PUT');
  assert.ok(puts.some((c) => c.url.endsWith('/documents/demo-es.json')), 'the manifest was PUT');
  assert.ok(calls.some((c) => c.method === 'MKCOL'), 'parent collections were MKCOL-ed');
  assert.ok(calls.every((c) => c.auth && c.auth.startsWith('Basic ')), 'Basic auth on every request');

  const [d2, f2] = mk('A2', '2026-02-02');
  await writeToSink(sink, [d2], f2, { service: 'documents', source: 'demo-es' });
  const mfUrl = Object.keys(store).find((u) => u.endsWith('/documents/demo-es.json'));
  const merged = JSON.parse(store[mfUrl]);
  assert.ok(Array.isArray(merged) && merged.length === 2, 'manifest accumulates both records across runs');

  restore();
});

test('webdav: no url throws (guards a misconfigured sink)', async () => {
  await assert.rejects(() => writeToSink({ id: 'x', type: 'webdav', url: '' }, [], new Map(), {}), /no url/);
});
