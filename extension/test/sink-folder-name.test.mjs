// Regression: a multi-output source's per-stream store key ("wizink-es:movimientos") is used as the
// per-source manifest FILENAME. The Chromium File System Access API rejects `:` (and \ / * ? " < > |) in
// names on every OS — so an unsanitized key made the manifest write throw, failing EVERY movements row
// (the movimientos stream has no PDF → its records live only in the manifest). The name must be sanitized.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeToSink } from '../src/sinks/sinks.js';

// Minimal in-memory dir handle that mimics Chromium's FSA name validation (throws on forbidden chars).
const FORBIDDEN = /[\\/:*?"<>|]/;
function makeDir(store = new Map()) {
  return {
    _store: store,
    async getDirectoryHandle(name, opts) {
      if (FORBIDDEN.test(name)) throw new TypeError(`Name is not allowed: ${name}`);
      if (!store.has(name)) { if (!opts || !opts.create) throw new DOMException('not found', 'NotFoundError'); store.set(name, makeDir()); }
      return store.get(name);
    },
    async getFileHandle(name, opts) {
      if (FORBIDDEN.test(name)) throw new TypeError(`Name is not allowed: ${name}`);
      const key = 'f:' + name;
      if (!store.has(key)) {
        if (!opts || !opts.create) throw new DOMException('not found', 'NotFoundError');
        store.set(key, { _data: '' });
      }
      const rec = store.get(key);
      return { createWritable: async () => ({ write: async (b) => { rec._data = typeof b === 'string' ? b : await b.text(); }, close: async () => {} }), getFile: async () => ({ text: async () => rec._data }) };
    },
  };
}

test('a colon-bearing source id (multi-output store key) yields a filesystem-safe manifest name', async () => {
  const root = makeDir();
  const docs = [{ internalId: 'ACC1|2026-06', date: '2026-06-30', record: { internalId: 'ACC1|2026-06', total: 12.5 } }];
  // movimientos-style delivery: NO artifacts, records live only in the manifest; source carries a ":".
  const r = await writeToSink({ type: 'local-folder' }, docs, new Map(), { dirHandle: root, service: 'wizink', source: 'wizink-es:movimientos' });
  assert.equal(r.total, 1);
  // The service dir exists and holds a manifest whose ":" was replaced (not rejected → not thrown).
  const svc = await root.getDirectoryHandle('wizink', {});
  const names = [...svc._store.keys()].filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
  assert.deepEqual(names, ['wizink-es-movimientos.json'], 'manifest filename must be sanitized');
  assert.ok(!names.some((n) => n.includes(':')), 'no colon in any written filename');
});
