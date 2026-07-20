// loadAuth merges a source's captured session across sibling hosts that share its registrable domain —
// so a single account JWT seen on one API host is found when the source lists against a sibling host
// (real case: IKEA's JWT captured on api.wlo.ingka.com, used for cssom-prod.ingka.com). No cross-domain
// LEAK: a host on an unrelated registrable domain is never merged in.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome.storage.session stub, installed before importing the module under test.
const SESSION = {};
globalThis.chrome = { storage: { session: { get: async (k) => (k == null ? { ...SESSION } : { [k]: SESSION[k] }) } } };
const { loadAuth, hasAuth, capturePathAllowed } = await import('../src/lib/authstore.js');

const IKEA = { id: 'ikea', api: { host: 'https://cssom-prod.ingka.com' }, crossDomainHosts: ['cssom-prod.ingka.com'], match: ['https://www.ikea.com/*'], auth: { mode: 'bearer' } };

test('loadAuth finds a JWT captured on a sibling host (same registrable domain)', async () => {
  for (const k of Object.keys(SESSION)) delete SESSION[k];
  SESSION['auth:api.wlo.ingka.com'] = { byPath: {}, merged: { authorization: 'Bearer eyJ.SIB.x' }, ctx: {} };
  const a = await loadAuth(IKEA);
  assert.ok(a, 'should resolve from the sibling ingka.com host');
  assert.equal(a.merged.authorization, 'Bearer eyJ.SIB.x');
  assert.equal(await hasAuth(IKEA), true);
});

test('api.host capture wins over a sibling on conflict', async () => {
  for (const k of Object.keys(SESSION)) delete SESSION[k];
  SESSION['auth:api.wlo.ingka.com'] = { merged: { authorization: 'Bearer SIBLING' } };
  SESSION['auth:cssom-prod.ingka.com'] = { byPath: { '/gql': { authorization: 'Bearer PRIMARY' } }, merged: { authorization: 'Bearer PRIMARY' } };
  const a = await loadAuth(IKEA);
  assert.equal(a.merged.authorization, 'Bearer PRIMARY');
  assert.deepEqual(a.byPath['/gql'], { authorization: 'Bearer PRIMARY' });
});

test('does NOT merge a host on an unrelated registrable domain', async () => {
  for (const k of Object.keys(SESSION)) delete SESSION[k];
  SESSION['auth:api.evil.com'] = { merged: { authorization: 'Bearer LEAK' } };
  const a = await loadAuth(IKEA);
  assert.equal(a, null); // nothing within ikea.com / ingka.com → no token
});

test('capturePathAllowed: allowlist restricts capture to the declared authenticated area', () => {
  const feci = { auth: { mode: 'cookie', replayHeaders: ['authorization'], capturePaths: ['/dashboard/'] } };
  assert.equal(capturePathAllowed(feci, '/dashboard/user'), true);
  assert.equal(capturePathAllowed(feci, '/dashboard/api/payments/x'), true);
  assert.equal(capturePathAllowed(feci, '/es/login'), false, 'login path is not a capture path');
  assert.equal(capturePathAllowed(feci, '/api/accessTokenTransmit'), false, 'token-minting endpoint is not captured from');
});

test('capturePathAllowed: denylist wins, and no lists means capture anywhere', () => {
  const deny = { auth: { mode: 'bearer', ignorePaths: ['/auth/'] } };
  assert.equal(capturePathAllowed(deny, '/auth/login'), false);
  assert.equal(capturePathAllowed(deny, '/api/data'), true);
  // a denylist hit wins even when an allowlist would also match
  const both = { auth: { capturePaths: ['/dashboard/'], ignorePaths: ['/dashboard/auth'] } };
  assert.equal(capturePathAllowed(both, '/dashboard/auth'), false);
  assert.equal(capturePathAllowed(both, '/dashboard/user'), true);
  // no lists → unrestricted (unchanged behavior)
  assert.equal(capturePathAllowed({ auth: { mode: 'bearer' } }, '/anything'), true);
  assert.equal(capturePathAllowed({}, '/anything'), true);
});
