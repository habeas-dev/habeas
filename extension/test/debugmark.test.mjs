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
globalThis.Headers = globalThis.Headers || class { constructor(i = {}) { this.m = new Map(Object.entries(i)); } set(k, v) { this.m.set(k, v); } get(k) { return this.m.get(k); } entries() { return this.m.entries(); } };

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
  const fetcher = withDebugMark(async (url, init) => { seen.push(init.headers[HEADER]); return { ok: true }; }, 'ing-es');
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
  assert.equal(out.headers.authorization, 'bearer x', 'replayed auth headers must survive');
  assert.equal(out.headers['x-csrf-token'], 'c');
  assert.ok(out.headers[HEADER]);
  assert.notEqual(out, init, 'the caller’s init must not be mutated');
});

test('headers stay a PLAIN OBJECT, whatever shape the caller used', () => {
  // A page-context source (ING, and any WAF-fronted API) hands its init to the site tab, which spreads
  // the headers: `{...new Headers(x)}` is `{}`. Returning a Headers instance here would silently drop
  // authorization and the CSRF header, turning every replay into a 401 — a failure indistinguishable
  // from the bug you would be chasing, caused by the debugging tool itself.
  for (const [label, headers] of [
    ['plain object', { authorization: 'bearer x' }],
    ['Headers instance', new Headers({ authorization: 'bearer x' })],
    ['entry array', [['authorization', 'bearer x']]],
    ['absent', undefined],
  ]) {
    const out = markInit({ headers }, 'ing-es');
    assert.equal(Object.getPrototypeOf(out.headers), Object.prototype, `${label}: headers must be a plain object`);
    assert.deepEqual({ ...out.headers }, out.headers, `${label}: must survive being spread`);
    if (headers) assert.equal({ ...out.headers }.authorization, 'bearer x', `${label}: auth header lost when spread`);
    assert.ok({ ...out.headers }[HEADER], `${label}: the marker must survive being spread`);
  }
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
