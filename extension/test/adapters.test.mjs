import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapter, checkHosts, registrableDomain } from '../src/adapters/validate.js';
import carrefour from '../src/adapters/carrefour-es.js';
import { EXAMPLE_ADAPTERS } from './fixtures/index.js';

test('all bundled + example adapters validate', () => {
  for (const a of [carrefour, ...EXAMPLE_ADAPTERS]) {
    const v = validateAdapter(a);
    assert.ok(v.ok, `${a.id}: ${v.errors.join('; ')}`);
  }
});

test('registrableDomain handles ccSLDs', () => {
  assert.equal(registrableDomain('pro.api.carrefour.es'), 'carrefour.es');
  assert.equal(registrableDomain('api.examplebank.com'), 'examplebank.com');
  assert.equal(registrableDomain('foo.bar.co.uk'), 'bar.co.uk');
  assert.equal(registrableDomain('app.bank.com.mx'), 'bank.com.mx');
});

test('same-domain guard rejects cross-domain without allowlist', () => {
  const evil = { ...carrefour, id: 'evil', api: { ...carrefour.api, host: 'https://attacker.com' } };
  const v = validateAdapter(evil);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('outside')));
});

test('cross-domain allowed when declared in crossDomainHosts', () => {
  const bank = EXAMPLE_ADAPTERS.find((a) => a.id === 'examplebank-es');
  const h = checkHosts(bank);
  assert.ok(h.ok);
  assert.deepEqual(h.crossDomain, ['examplebank.com']);
});

test('adapter with a function value is rejected (data only)', () => {
  const withCode = { ...carrefour, categorize: () => 'x' };
  assert.equal(validateAdapter(withCode).ok, false);
});

test('brand domains: several TLDs of one brand are allowed WITHOUT off-site consent', () => {
  const amazon = {
    domain: 'amazon.es', domains: ['amazon.es', 'amazon.com', 'amazon.de'],
    match: ['https://www.amazon.es/*', 'https://www.amazon.com/*', 'https://www.amazon.de/*'],
    api: { host: 'https://www.amazon.es' },
  };
  const h = checkHosts(amazon);
  assert.ok(h.ok, 'all brand TLDs allowed');
  assert.deepEqual(h.crossDomain, [], 'no off-site consent for same-brand domains');
  assert.ok(h.brand.includes('amazon.de') && h.brand.includes('amazon.com'));
});

test('brand domains do NOT open the door to an unrelated host', () => {
  const leaky = { domain: 'amazon.es', domains: ['amazon.es'], match: ['https://www.amazon.es/*', 'https://evil.example/*'], api: { host: 'https://www.amazon.es' } };
  assert.equal(checkHosts(leaky).ok, false, 'a non-brand host is still rejected');
});

test('a multi-domain (brand) source must be cookie-mode', () => {
  const base = {
    id: 'brandtest', name: 'Brand', service: 'brand', schema: 'receipt@1', categories: ['marketplace'],
    domain: 'amazon.es', domains: ['amazon.es', 'amazon.com'],
    match: ['https://www.amazon.es/*', 'https://www.amazon.com/*'],
    auth: { mode: 'cookie', replayHeaders: [] },
    api: { host: 'https://www.amazon.es', list: { path: '/orders', from: 'html', rows: { each: 'id-([0-9]+)', fields: { internalId: { group: 1 } } } } },
    fields: { internalId: 'internalId', date: '_year' },
  };
  assert.ok(validateAdapter(base).ok, validateAdapter(base).errors.join('; '));
  const notCookie = { ...base, auth: { replayHeaders: ['authorization'] } };
  const v = validateAdapter(notCookie);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('cookie')), 'rejected for not being cookie-mode');
});

test('http api.host allowed only for loopback (dev/testing sources)', () => {
  const local = { ...carrefour, id: 'local-mock', domain: 'localhost', match: ['http://localhost/*'], openUrl: undefined, api: { ...carrefour.api, host: 'http://localhost:8443' } };
  assert.ok(validateAdapter(local).ok, validateAdapter(local).errors.join('; '));
  const plainHttp = { ...carrefour, id: 'insecure', domain: 'shop.es', match: ['http://shop.es/*'], openUrl: undefined, api: { ...carrefour.api, host: 'http://shop.es' } };
  assert.equal(validateAdapter(plainHttp).ok, false);
});
