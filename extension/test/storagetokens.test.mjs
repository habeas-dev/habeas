// collectStorageTokens surfaces, from a recording's client storage, WHERE tokens live (path + kind, never a
// value) — so the team wires auth.tokenFromStorage without asking a non-technical contributor to open
// DevTools. Raisin stores localStorage.auth_token = { access_token, refresh_token, … }. All values SYNTHETIC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectStorageTokens } from '../src/lib/redact.js';

const JWT = (tag) => 'eyJ' + tag + '.eyJwYXlsb2Fk.c2ln'; // shape only, synthetic

test('finds the access token inside a stored token object (OAuth shape), tagging kinds', () => {
  const storage = { local: {
    auth_token: JSON.stringify({ access_token: JWT('A'), refresh_token: JWT('R'), id_token: JWT('I'), expires_in: 900, scope: 'openid' }),
    _grecaptcha: 'x'.repeat(30), // not a JWT → ignored
  }, session: {} };
  const locs = collectStorageTokens(storage);
  const byPath = Object.fromEntries(locs.map((l) => [l.path, l.kind]));
  assert.equal(byPath['local.auth_token.access_token'], 'access');
  assert.equal(byPath['local.auth_token.refresh_token'], 'refresh');
  assert.equal(byPath['local.auth_token.id_token'], 'id');
  assert.equal(locs.length, 3, 'only the JWT-valued fields are surfaced');
});

test('keycloak-js shape: bare `token` is the access token; a top-level JWT string too', () => {
  const storage = { local: { kc: JSON.stringify({ token: JWT('A'), refreshToken: JWT('R'), idToken: JWT('I') }) }, session: { raw_access: JWT('S') } };
  const locs = collectStorageTokens(storage);
  const byPath = Object.fromEntries(locs.map((l) => [l.path, l.kind]));
  assert.equal(byPath['local.kc.token'], 'access');
  assert.equal(byPath['local.kc.refreshToken'], 'refresh');
  assert.equal(byPath['session.raw_access'], 'access'); // key contains "access"
});

test('no JWTs in storage → empty (never emits a non-token)', () => {
  assert.deepEqual(collectStorageTokens({ local: { session_id: 'abc-123', n: '42' }, session: {} }), []);
  assert.deepEqual(collectStorageTokens(null), []);
});
