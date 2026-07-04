import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub chrome.storage.local BEFORE importing modules that read the ext.js shim at load time.
const store = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => ({ [k]: store[k] }),
  set: async (o) => Object.assign(store, o),
} } };

const { needsConsent, hasConsent, grantConsent, revokeConsent } = await import('../src/lib/consent.js');
const { default: carrefour } = await import('../src/adapters/carrefour-es.js');
const { EXAMPLE_ADAPTERS } = await import('../src/adapters/examples/index.js');
const bank = EXAMPLE_ADAPTERS.find((a) => a.id === 'examplebank-es');
const mart = EXAMPLE_ADAPTERS.find((a) => a.id === 'examplemart-es');

test('first-party same-domain source needs no consent', async () => {
  assert.equal(needsConsent(carrefour), false);
  assert.equal(await hasConsent(carrefour), true);
});

test('community source requires consent, granted then persists', async () => {
  assert.equal(needsConsent(mart), true);
  assert.equal(await hasConsent(bank), false);
  await grantConsent(bank);
  assert.equal(await hasConsent(bank), true);
});

test('changing hosts invalidates prior consent (signature mismatch)', async () => {
  await grantConsent(bank);
  const tampered = { ...bank, crossDomainHosts: [...bank.crossDomainHosts, 'evil.com'] };
  assert.equal(await hasConsent(tampered), false);
});

test('revoke clears consent', async () => {
  await grantConsent(bank);
  await revokeConsent(bank.id);
  assert.equal(await hasConsent(bank), false);
});
