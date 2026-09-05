import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinkIsOriginBound, validateProposal, validateSink, sinkIdForOrigin, enabledSources } from '../src/lib/exthooks.js';

test('origin-bound: the sink URL host must equal the requesting origin (https, or http on loopback)', () => {
  assert.ok(sinkIsOriginBound('https://tiquetera.app', 'https://tiquetera.app/ingest'));
  assert.ok(!sinkIsOriginBound('https://tiquetera.app', 'https://evil.com/ingest'), 'cross-origin rejected');
  assert.ok(!sinkIsOriginBound('https://tiquetera.app', 'http://tiquetera.app/ingest'), 'http rejected on a real host');
  assert.ok(!sinkIsOriginBound('https://a.tiquetera.app', 'https://tiquetera.app/i'), 'different host (subdomain) rejected');
  assert.ok(!sinkIsOriginBound('', 'https://x.app/i'));
});

test('origin-bound: loopback sinks may be plain http (local development)', () => {
  assert.ok(sinkIsOriginBound('http://localhost:5173', 'http://localhost:5173/ingest'), 'http localhost accepted');
  assert.ok(sinkIsOriginBound('http://127.0.0.1:8080', 'http://127.0.0.1:8080/ingest'), 'http 127.0.0.1 accepted');
  assert.ok(sinkIsOriginBound('https://localhost:8443', 'https://localhost:8443/ingest'), 'https localhost still fine');
  assert.ok(sinkIsOriginBound('http://app.localhost', 'http://app.localhost/ingest'), '*.localhost accepted');
  // Origin-binding still applies: only a page ON localhost can point at localhost.
  assert.ok(!sinkIsOriginBound('https://tiquetera.app', 'http://localhost/ingest'), 'remote origin cannot target localhost');
  assert.ok(!sinkIsOriginBound('http://localhost', 'http://tiquetera.app/ingest'), 'localhost origin cannot target a remote http host');
  // Lookalikes are NOT loopback.
  assert.ok(!sinkIsOriginBound('http://localhost.evil.com', 'http://localhost.evil.com/i'), 'localhost.evil.com is not loopback');
  assert.ok(!sinkIsOriginBound('http://127.0.0.1.evil.com', 'http://127.0.0.1.evil.com/i'), '127.0.0.1.evil.com is not loopback');
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

test('validateSink accepts an origin-bound http sink with NO source, rejects the rest', () => {
  const good = validateSink('https://cuentamo.app', { sink: { type: 'http', url: 'https://cuentamo.app/ingest', name: 'Cuéntamo' } });
  assert.ok(good.ok, 'origin-bound sink, no source needed');
  assert.equal(good.sink.url, 'https://cuentamo.app/ingest');
  assert.equal(good.sink.name, 'Cuéntamo');
  assert.ok(!validateSink('https://cuentamo.app', { sink: { type: 'http', url: 'https://evil.com/x' } }).ok, 'cross-origin rejected');
  assert.ok(!validateSink('https://cuentamo.app', { sink: { type: 'drive' } }).ok, 'non-http sink rejected');
  assert.ok(!validateSink('', { sink: { type: 'http', url: 'https://x.app/i' } }).ok, 'no origin rejected');
  assert.ok(!validateSink('https://cuentamo.app', {}).ok, 'missing sink rejected');
});

test('sinkIdForOrigin is stable and host-derived', () => {
  assert.equal(sinkIdForOrigin('https://tiquetera.app'), 'ext-tiquetera-app');
  assert.equal(sinkIdForOrigin('https://tiquetera.app'), sinkIdForOrigin('https://tiquetera.app/other-path'));
});

test('validateProposal captures a proposed name (sanitized + length-capped), omits it when absent', () => {
  const base = { source: 'carrefour-es', sink: { type: 'http', url: 'https://tiquetera.app/ingest' } };
  assert.equal(validateProposal('https://tiquetera.app', base).sink.name, undefined); // no name → omitted
  const named = validateProposal('https://tiquetera.app', { ...base, sink: { ...base.sink, name: '  Tiquetera\n ' } });
  assert.equal(named.sink.name, 'Tiquetera'); // trimmed, newlines stripped
  const long = validateProposal('https://tiquetera.app', { ...base, sink: { ...base.sink, name: 'x'.repeat(80) } });
  assert.equal(long.sink.name.length, 40); // length-capped
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

test('sanitizeQuery: caps strings, keeps numbers, drops junk', async () => {
  const { sanitizeQuery } = await import('../src/lib/exthooks.js');
  const q = sanitizeQuery({
    schema: 'receipt', source: 'amazon.es', text: 'x'.repeat(500),
    dateFrom: '2026-08-13', dateTo: '2026-08-25', amount: -47.85, amountTolerance: 0.02,
    currency: 'EUR', evil: 'ignored', amountEvil: NaN,
  });
  assert.equal(q.schema, 'receipt');
  assert.equal(q.source, 'amazon.es');
  assert.equal(q.text.length, 200, 'free text capped');
  assert.equal(q.amount, -47.85);
  assert.equal(q.amountTolerance, 0.02);
  assert.equal('evil' in q, false, 'unexpected keys dropped');
  const bad = sanitizeQuery({ amount: 'not-a-number', dateFrom: 123 });
  assert.equal(bad.amount, undefined, 'non-numeric amount dropped');
  assert.equal(bad.dateFrom, undefined, 'non-string date dropped');
  assert.deepEqual(sanitizeQuery(null), sanitizeQuery({}), 'null query is the empty query');
});

test('queryAccepts: date range, absolute-amount tolerance, free text', async () => {
  const { queryAccepts } = await import('../src/lib/exthooks.js');
  const rec = { date: '2026-08-15T09:00:00Z', total: 47.85, currency: 'EUR', number: 'A-1', description: 'Books' };

  // A consumer's SIGNED charge (-47.85) matches a receipt's positive total: absolute value + tolerance.
  assert.ok(queryAccepts(rec, { amount: -47.85, amountTolerance: 0.02 }, 'Amazon'));
  assert.ok(queryAccepts(rec, { amount: -47.86, amountTolerance: 0.02 }, 'Amazon'), 'within tolerance');
  assert.ok(!queryAccepts(rec, { amount: -47.90, amountTolerance: 0.02 }, 'Amazon'), 'outside tolerance rejected');

  // Date range (booked-date string compare).
  assert.ok(queryAccepts(rec, { dateFrom: '2026-08-13', dateTo: '2026-08-25' }, ''));
  assert.ok(!queryAccepts(rec, { dateFrom: '2026-08-16' }, ''), 'before range rejected');
  assert.ok(!queryAccepts(rec, { dateTo: '2026-08-14' }, ''), 'after range rejected');

  // Free text hits counterparty, description or number; case-insensitive.
  assert.ok(queryAccepts(rec, { text: 'amaz' }, 'Amazon'), 'matches counterparty');
  assert.ok(queryAccepts(rec, { text: 'books' }, 'Amazon'), 'matches description');
  assert.ok(!queryAccepts(rec, { text: 'zzz' }, 'Amazon'), 'no match rejected');

  // Empty query accepts anything; a missing record never matches.
  assert.ok(queryAccepts(rec, {}, ''));
  assert.ok(!queryAccepts(null, { amount: 1 }, ''));
});
