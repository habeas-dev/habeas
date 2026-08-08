import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome shim: the module reads/writes storage.local and listens for changes.
const store = {};
const listeners = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: store[k] }),
      set: async (o) => { Object.assign(store, o); for (const l of listeners) l({ 'habeas:debugMark': { newValue: o['habeas:debugMark'] } }, 'local'); },
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  },
};
globalThis.Headers = globalThis.Headers || class { constructor(i = {}) { this.m = new Map(Object.entries(i)); } set(k, v) { this.m.set(k, v); } get(k) { return this.m.get(k); } };

const { markInit, withDebugMark, setDebugMark, debugMarkEnabled, HEADER } = await import('../src/lib/debugmark.js');

test('the marker is off by default, and a request is untouched while it is', async () => {
  assert.equal(await debugMarkEnabled(), false, 'must default to off — it can break a source and it identifies Habeas to the service');

  let seen = null;
  const fetcher = withDebugMark(async (url, init) => { seen = init; return { ok: true }; }, 'ing-es');
  const init = { method: 'GET', headers: { authorization: 'bearer x' } };
  await fetcher('https://example.test/a', init);
  // Byte-identical: the request must stay exactly what the site's own SPA would send.
  assert.equal(seen, init, 'the init object must be passed through untouched while the toggle is off');
});

test('once on, every request carries the header, tagged by source and sequence', async () => {
  await setDebugMark(true);
  assert.equal(await debugMarkEnabled(), true);

  const seen = [];
  const fetcher = withDebugMark(async (url, init) => { seen.push(init.headers.get(HEADER)); return { ok: true }; }, 'ing-es');
  await fetcher('https://example.test/a', { headers: { authorization: 'bearer x' } });
  await fetcher('https://example.test/b', {});

  assert.match(seen[0], /^ing-es\/\d+$/, 'the tag names the source so a proxy log can be filtered per source');
  assert.notEqual(seen[0], seen[1], 'each request needs its own tag, to follow a sweep request by request');
  await setDebugMark(false);
});

test('marking preserves the headers the source depends on', () => {
  const init = { method: 'POST', body: '{}', headers: { authorization: 'bearer x', 'x-csrf-token': 'c' } };
  const out = markInit(init, 'wizink-es');
  assert.equal(out.method, 'POST');
  assert.equal(out.body, '{}');
  assert.equal(out.headers.get('authorization'), 'bearer x', 'replayed auth headers must survive');
  assert.equal(out.headers.get('x-csrf-token'), 'c');
  assert.ok(out.headers.get(HEADER));
  assert.notEqual(out, init, 'the caller’s init must not be mutated');
});

test('the extension and the mitmproxy addon agree on the header name', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const addon = await fs.readFile(path.join(root, 'tools', 'mitm-habeas.py'), 'utf8');

  // If these drift the marker silently stops being stripped, and it starts reaching the service —
  // the exact failure the addon exists to prevent, with no visible symptom.
  assert.match(addon, new RegExp(`HEADER = "${HEADER}"`), 'the addon must strip the header the extension sends');

  // The addon must actually remove it before forwarding, and patch the preflight, or the two
  // documented costs come back.
  assert.match(addon, /del flow\.request\.headers\[HEADER\]/, 'the addon must strip the header before forwarding');
  assert.match(addon, /ACAH\b[\s\S]*Access-Control-Allow-Headers/, 'the addon must answer the CORS preflight');
  assert.match(addon, /habeas_keep_header/, 'forwarding it must stay an explicit opt-in');
});
