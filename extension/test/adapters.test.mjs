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

test('http api.host allowed only for loopback (dev/testing sources)', () => {
  const local = { ...carrefour, id: 'local-mock', domain: 'localhost', match: ['http://localhost/*'], openUrl: undefined, api: { ...carrefour.api, host: 'http://localhost:8443' } };
  assert.ok(validateAdapter(local).ok, validateAdapter(local).errors.join('; '));
  const plainHttp = { ...carrefour, id: 'insecure', domain: 'shop.es', match: ['http://shop.es/*'], openUrl: undefined, api: { ...carrefour.api, host: 'http://shop.es' } };
  assert.equal(validateAdapter(plainHttp).ok, false);
});
