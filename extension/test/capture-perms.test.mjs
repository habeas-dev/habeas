import { test } from 'node:test';
import assert from 'node:assert/strict';

// ext.js binds `chrome` from globalThis at import time — set a mock BEFORE importing capture.js.
let lastQuery = null;
let containsImpl = async () => true;
globalThis.chrome = {
  permissions: {
    contains: async (q) => { lastQuery = q; return containsImpl(q); },
    request: async () => true,
  },
};
const { originsFor, hasCapturePermissions } = await import('../src/lib/capture.js');

const ING = {
  id: 'ing-es',
  match: ['https://ing.ingdirect.es/*'],
  api: { host: 'https://api.ing.ingdirect.es' },
};

test('originsFor covers the match site AND the API host', () => {
  const o = originsFor(ING);
  assert.ok(o.includes('https://ing.ingdirect.es/*'), 'match site');
  assert.ok(o.includes('https://api.ing.ingdirect.es/*'), 'API host');
});

test('originsFor includes crossDomainHosts', () => {
  const o = originsFor({ ...ING, crossDomainHosts: ['other.example.com'] });
  assert.ok(o.includes('https://other.example.com/*'));
});

test('hasCapturePermissions reflects permissions.contains and queries the right origins', async () => {
  containsImpl = async () => true;
  assert.equal(await hasCapturePermissions(ING), true);
  assert.deepEqual(lastQuery, { origins: originsFor(ING) });

  containsImpl = async () => false; // e.g. revoked after a Firefox add-on reload
  assert.equal(await hasCapturePermissions(ING), false);
});

test('hasCapturePermissions defaults to true if the check itself throws (never blocks a fine run)', async () => {
  containsImpl = async () => { throw new Error('permissions API unavailable'); };
  assert.equal(await hasCapturePermissions(ING), true);
});
