// Externally-proposed http sinks may carry request headers (a pairing token). Those must NOT sit in
// plaintext config — they get moved into the encrypted secrets store and referenced by `headersRef`.
// Stubs chrome.storage.local and injects a stable in-memory secrets key (no IndexedDB in node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey } from '../src/lib/crypto.js';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k == null ? { ...LOCAL } : { [k]: LOCAL[k] }),
  set: async (obj) => { Object.assign(LOCAL, obj); },
} } };

const { _setKeyProvider } = await import('../src/lib/secrets.js');
const { secureSinkHeaders, resolveSinkExtraHeaders, migrateSinkHeaders, headersRefFor } = await import('../src/lib/sinkheaders.js');
_setKeyProvider(async () => KEY);
const KEY = await generateSecretKey();

const reset = () => { for (const k of Object.keys(LOCAL)) delete LOCAL[k]; };

test('secureSinkHeaders moves inline headers into an encrypted secret and swaps in a headersRef', async () => {
  reset();
  const secured = await secureSinkHeaders({ id: 'ext-tiquetera-app', type: 'http', url: 'https://tiquetera.app/i', headers: { 'x-pair': 'tok-123' } });
  assert.equal(secured.headers, undefined, 'no inline headers left on the config-facing sink');
  assert.equal(secured.headersRef, headersRefFor('ext-tiquetera-app'));
  assert.ok(!JSON.stringify(LOCAL['habeas:secrets']).includes('tok-123'), 'token stored encrypted, not plaintext');
  assert.deepEqual(await resolveSinkExtraHeaders(secured), { 'x-pair': 'tok-123' }, 'round-trips back to the same headers');
});

test('a sink with no headers (or already ref\'d) is returned unchanged', async () => {
  reset();
  const s = await secureSinkHeaders({ id: 'x', type: 'http', url: 'https://x.app/i' });
  assert.equal(s.headersRef, undefined);
  assert.deepEqual(await resolveSinkExtraHeaders(s), {});
});

test('legacy inline headers are still honored (pre-encryption installs)', async () => {
  reset();
  assert.deepEqual(await resolveSinkExtraHeaders({ type: 'http', headers: { a: 'b' } }), { a: 'b' });
});

test('migrateSinkHeaders converts existing plaintext http sinks in config, leaves others', async () => {
  reset();
  LOCAL['habeas:config'] = { version: 1, datasources: [], routes: [], sinks: [
    { id: 'ext-a', type: 'http', url: 'https://a.app/i', headers: { x: 'sekret' } },
    { id: 'dl', type: 'download' },
  ] };
  await migrateSinkHeaders();
  const cfg = LOCAL['habeas:config'];
  const a = cfg.sinks.find((s) => s.id === 'ext-a');
  assert.equal(a.headers, undefined, 'plaintext headers removed from config');
  assert.equal(a.headersRef, headersRefFor('ext-a'));
  assert.ok(!JSON.stringify(cfg).includes('sekret'), 'no plaintext token anywhere in config');
  assert.deepEqual(await resolveSinkExtraHeaders(a), { x: 'sekret' });
  assert.deepEqual(cfg.sinks.find((s) => s.id === 'dl'), { id: 'dl', type: 'download' }, 'non-http sink untouched');
});
