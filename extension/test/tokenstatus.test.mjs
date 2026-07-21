// tokenStatus turns the SENT bearer's decoded claims (exp/iss, decoded page-side, never the raw token) into a
// human diagnostic line — so a failed auth request says whether the token was expired or fresh, without any
// DevTools. This is the instrumentation that finally answers "was the token stale?" for a source like Raisin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenStatus } from '../src/runtime/inventory.js';

test('reports an EXPIRED token with how long ago + the issuer host', () => {
  const now = 1_800_000_000;
  const s = tokenStatus({ sentToken: { exp: now - 780, iss: 'https://auth.weltsparen.de/auth/realms/global', now } });
  assert.match(s, /token EXPIRED 13min ago/);
  assert.match(s, /iss=auth\.weltsparen\.de/);
});

test('reports a valid token with seconds remaining', () => {
  const now = 1_800_000_000;
  assert.match(tokenStatus({ sentToken: { exp: now + 600, now } }), /token valid 600s/);
});

test('no sent-token info → empty (older builds / no bearer decoded)', () => {
  assert.equal(tokenStatus({}), '');
  assert.equal(tokenStatus({ sentToken: { iss: 'x' } }), ''); // no exp → nothing to say
  assert.equal(tokenStatus(null), '');
});
