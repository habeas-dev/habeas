import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinkIsOriginBound, validateProposal, sinkIdForOrigin, enabledSources } from '../src/lib/exthooks.js';

test('origin-bound: the sink URL host must equal the requesting origin (https only)', () => {
  assert.ok(sinkIsOriginBound('https://tiquetera.app', 'https://tiquetera.app/ingest'));
  assert.ok(!sinkIsOriginBound('https://tiquetera.app', 'https://evil.com/ingest'), 'cross-origin rejected');
  assert.ok(!sinkIsOriginBound('https://tiquetera.app', 'http://tiquetera.app/ingest'), 'http rejected');
  assert.ok(!sinkIsOriginBound('https://a.tiquetera.app', 'https://tiquetera.app/i'), 'different host (subdomain) rejected');
  assert.ok(!sinkIsOriginBound('', 'https://x.app/i'));
});

test('validateProposal accepts an origin-bound http sink, rejects the rest', () => {
  const good = validateProposal('https://tiquetera.app', {
    source: 'carrefour-es',
    sink: { type: 'http', url: 'https://tiquetera.app/ingest', headers: { 'x-pair': 'tok' } },
    filter: { categories: ['grocery'] },
  });
  assert.ok(good.ok);
  assert.equal(good.sink.url, 'https://tiquetera.app/ingest');
  assert.deepEqual(good.sink.headers, { 'x-pair': 'tok' });
  assert.deepEqual(good.filter.categories, ['grocery']);

  // Cross-origin sink → the single rule that blocks exfiltration.
  assert.ok(!validateProposal('https://tiquetera.app', { source: 'carrefour-es', sink: { type: 'http', url: 'https://evil.com/x' } }).ok);
  // Missing/invalid pieces.
  assert.ok(!validateProposal('https://tiquetera.app', { source: '', sink: { type: 'http', url: 'https://tiquetera.app/i' } }).ok);
  assert.ok(!validateProposal('', { source: 'x', sink: { type: 'http', url: 'https://x.app/i' } }).ok);
  assert.ok(!validateProposal('https://tiquetera.app', { source: 'x', sink: { type: 'drive' } }).ok);
});

test('sinkIdForOrigin is stable and host-derived', () => {
  assert.equal(sinkIdForOrigin('https://tiquetera.app'), 'ext-tiquetera-app');
  assert.equal(sinkIdForOrigin('https://tiquetera.app'), sinkIdForOrigin('https://tiquetera.app/other-path'));
});

test('enabledSources returns only enabled datasources, as public metadata (no accounts/data)', () => {
  const adapters = {
    'ing-es': { id: 'ing-es', name: 'ING España', service: 'ing', categories: ['banking'], trust: 'community', api: { host: 'x' } },
    'demo-shop': { id: 'demo-shop', name: 'Demo Shop', service: 'demo', categories: ['retail'] },
  };
  const cfg = { datasources: [
    { id: 'ing-es', adapter: 'ing-es', enabled: true },
    { id: 'demo-shop', adapter: 'demo-shop', enabled: false },   // disabled → excluded
    { id: 'ghost', adapter: 'not-installed', enabled: true },    // adapter missing → excluded
  ] };
  const out = enabledSources(cfg, adapters);
  assert.deepEqual(out, [{ source: 'ing-es', name: 'ING España', service: 'ing', categories: ['banking'], trust: 'community' }]);
  // defaults + no leakage of non-metadata fields (api/host never surface)
  assert.ok(!('api' in out[0]) && !('host' in out[0]));
  assert.equal(enabledSources({}, adapters).length, 0);
  assert.equal(enabledSources(null, null).length, 0);
});
