import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrandHost, siteBaseUrl } from '../src/lib/pagefetch.js';

const AMAZON = { id: 'amazon', domains: ['amazon.es', 'amazon.com', 'amazon.de'], api: { host: 'https://www.amazon.com' } };

test('a pinned instance country wins over whatever brand tab is open', () => {
  // On an amazon.es tab, refreshing the amazon.com instance must still target .com (not write .es into .com).
  const r = withBrandHost(AMAZON, { origin: 'https://www.amazon.es' }, { brandDomain: 'amazon.com' });
  assert.equal(r.api.host, 'https://www.amazon.com');
});

test('an un-pinned brand source follows the tab', () => {
  const r = withBrandHost(AMAZON, { origin: 'https://www.amazon.es' }, {});
  assert.equal(r.api.host, 'https://www.amazon.es');
});

test('a pinned instance resolves its host even with no tab (unattended run)', () => {
  const r = withBrandHost(AMAZON, null, { brandDomain: 'amazon.de' });
  assert.equal(r.api.host, 'https://www.amazon.de');
});

test('a pin to a domain the source does not declare is ignored', () => {
  const r = withBrandHost(AMAZON, { origin: 'https://www.amazon.es' }, { brandDomain: 'evil.com' });
  assert.equal(r.api.host, 'https://www.amazon.es'); // falls back to the tab, not the bogus pin
});

test('a non-brand (single-domain) source is returned unchanged', () => {
  const dia = { id: 'dia', api: { host: 'https://api.dia.es' } };
  assert.equal(withBrandHost(dia, { origin: 'https://x' }, { brandDomain: 'y' }), dia);
});

test('siteBaseUrl opens the pinned country', () => {
  assert.equal(siteBaseUrl(AMAZON, { brandDomain: 'amazon.de' }), 'https://www.amazon.de/');
});
