import { test } from 'node:test';
import assert from 'node:assert/strict';

// A BEHAVIOURAL test for the page-side copy, which until now had only structural ones — assertions about
// the source text. Those cannot catch the failure that actually reached the user: removing a duplicated
// block by line number took the statement that builds `docs` with it, and the file still parsed, still
// passed `node --check`, still satisfied every grep. It failed at run time with "docs is not defined".
//
// Structural tests describe intent; only running the thing proves it runs. The seam is setBackend(),
// which the store exports for exactly this.

const mem = {};
globalThis.chrome = {
  storage: { local: {
    get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) if (mem[x] !== undefined) o[x] = mem[x]; return o; },
    set: async (o) => { Object.assign(mem, o); },
  } },
  runtime: { getURL: (p) => 'x/' + p },
};

const { setBackend } = await import('../src/lib/store.js');
const { copyArchivePageSide } = await import('../src/lib/foldercopy.js');

// `items` is an OBJECT keyed by internalId, each { record } — not an array. Getting that wrong is how
// this test passed while proving nothing: every record came back undefined, the source looked empty, and
// the copy returned before reaching the loop under examination.
const ITEMS = {
  A: { record: { internalId: 'A', date: '2026-03-01', total: 12.5, currency: 'EUR' } },
  B: { record: { internalId: 'B', date: '2026-03-02', total: -4, currency: 'EUR' } },
};
setBackend({
  async loadSource() { return { meta: {}, items: ITEMS }; },
  async saveSource() {},
  async listSources() { return ['demo']; },
});

const ADAPTERS = {
  demo: {
    id: 'demo', name: 'Demo', service: 'demo', schema: 'receipt@1',
    api: { host: 'https://x.test', list: { path: '/l' }, pdf: { path: '/p/{internalId}' } },
    fields: { internalId: 'internalId', date: 'date', total: 'total' },
  },
};
const cfg = (target, sinks) => ({ sinks, datasources: [{ id: 'ds1', adapter: 'demo', enabled: true }] });

test('the copy runs end to end without a reference error', async () => {
  // The whole point: EXECUTE the loop. Nothing is expected to be found — every retrieval fails against a
  // fetch that answers nothing — but the body must run, and it did not.
  // The destination accepts; the ORIGIN has nothing. That is the ordinary shape of this run: records
  // travel, files are looked for and not found.
  globalThis.fetch = async (url) => (String(url).includes('consumer.test')
    ? { ok: true, status: 200, json: async () => ({ written: 0 }), text: async () => '{}' }
    : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  const target = { id: 'http1', type: 'http', url: 'https://consumer.test/in' };
  const from = { id: 'dbx', type: 'dropbox', name: 'Dropbox' };
  const r = await copyArchivePageSide(cfg(target, [from, target]), ADAPTERS, target, { originId: '' });
  // It must have REACHED the documents. `found` proves the loop under examination executed; without it
  // this passes on an empty source and proves nothing, which is how the first version of it failed.
  assert.equal(r.found, 2, 'both records must have been considered');
  assert.equal(r.skipped, 2, 'and both skipped, since no origin has their file');
});

test('a target with no readable origin does no work and says nothing was found', async () => {
  const target = { id: 'http1', type: 'http', url: 'https://consumer.test/in' };
  const r = await copyArchivePageSide(cfg(target, [target]), ADAPTERS, target, { originId: '' });
  assert.deepEqual({ sent: r.sent, found: r.found, skipped: r.skipped }, { sent: 0, found: 0, skipped: 0 });
});

test('a stopped run returns stopped rather than pretending to finish', async () => {
  const target = { id: 'http1', type: 'http', url: 'https://consumer.test/in' };
  const from = { id: 'dbx', type: 'dropbox', name: 'Dropbox' };
  const ac = new AbortController(); ac.abort();
  const r = await copyArchivePageSide(cfg(target, [from, target]), ADAPTERS, target, { originId: '', signal: ac.signal });
  assert.equal(r.stopped, true);
});
