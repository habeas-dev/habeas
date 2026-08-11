import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteMatches, knownSite } from '../src/lib/sitematch.js';

// Extracted from background.js so the popup can answer "does Habeas already know this site?" without
// duplicating the rule. Synthetic adapters throughout.

test('a source matches its own site and its subdomains', () => {
  const a = { domain: 'ejemplo.test', match: ['https://www.ejemplo.test/*'], api: { host: 'api.ejemplo.test' } };
  assert.ok(siteMatches(a, 'ejemplo.test'));
  assert.ok(siteMatches(a, 'www.ejemplo.test'));
  assert.ok(siteMatches(a, 'mi.cuenta.ejemplo.test'));
  assert.ok(!siteMatches(a, 'otracosa.test'));
});

test('a lookalike host that merely ends with the same letters does not match', () => {
  const a = { domain: 'ejemplo.test', match: [], api: { host: 'ejemplo.test' } };
  assert.ok(!siteMatches(a, 'noesejemplo.test'), 'suffix matching must respect the dot boundary');
});

test('a match pattern alone is enough, with or without a wildcard subdomain', () => {
  const a = { match: ['https://*.tienda.test/pedidos'] , api: { host: 'api.otra.test' } };
  assert.ok(siteMatches(a, 'tienda.test'));
  assert.ok(siteMatches(a, 'shop.tienda.test'));
});

test('an adapter with no api block does not throw', () => {
  assert.doesNotThrow(() => siteMatches({ match: ['https://a.test/*'] }, 'b.test'));
  assert.equal(siteMatches({ match: ['https://a.test/*'] }, 'b.test'), false);
});

test('knownSite finds the first source covering a host, or nothing', () => {
  const all = {
    uno: { id: 'uno', name: 'Uno', domain: 'uno.test' },
    dos: { id: 'dos', name: 'Dos', match: ['https://www.dos.test/*'] },
  };
  assert.equal(knownSite(all, 'www.dos.test').id, 'dos');
  assert.equal(knownSite(all, 'tres.test'), null);
  assert.equal(knownSite(all, ''), null);
  assert.equal(knownSite(null, 'uno.test'), null);
});
