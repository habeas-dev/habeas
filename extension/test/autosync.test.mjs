import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure scheduling policy for the background auto-sync runner — no chrome shim needed.
const { autoDebounced, retainAutoDebounce, isLoginNavigation, needsTabEscalation, AUTO_DEBOUNCE_MS } = await import('../src/lib/autosync.js');

test('needsTabEscalation: a session/challenge/auth failure escalates to a tab; success/hard-error do not', () => {
  assert.equal(needsTabEscalation({ status: 'done', new: 2 }), false);
  assert.equal(needsTabEscalation({ status: 'nosession' }), true);
  assert.equal(needsTabEscalation({ status: 'challenged' }), true);
  assert.equal(needsTabEscalation({ status: 'error', error: 'list 403 forbidden' }), true);
  assert.equal(needsTabEscalation({ status: 'error', error: 'csrf 400' }), true);
  assert.equal(needsTabEscalation({ status: 'error', error: 'no matching adapter' }), false);
  assert.equal(needsTabEscalation(null), false);
});

const wizink = { auth: { loginUrl: 'https://www.wizink.es/login' } };

test('isLoginNavigation: the login page is a pre-auth navigation → skip the auto-run there', () => {
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/login'), true);
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/login?error=1'), true);
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/login/otp'), true);
});

test('isLoginNavigation: the post-login data page is NOT the login page → run', () => {
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/clientes/posicion-global'), false);
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/loginx'), false); // not a path segment
});

test('isLoginNavigation: no loginUrl declared, or no url → never a login navigation', () => {
  assert.equal(isLoginNavigation({ auth: {} }, 'https://www.wizink.es/login'), false);
  assert.equal(isLoginNavigation(wizink, ''), false);
  assert.equal(isLoginNavigation(wizink, undefined), false);
});

test('autoDebounced: a route that never ran (or whose debounce was cleared) may run', () => {
  assert.equal(autoDebounced(undefined, 1_000), false);
  assert.equal(autoDebounced(null, 1_000), false);
});

test('autoDebounced: within the window it is held; past the window it is free', () => {
  const now = 10_000_000;
  assert.equal(autoDebounced(now - 1_000, now), true);
  assert.equal(autoDebounced(now - (AUTO_DEBOUNCE_MS - 1), now), true);
  assert.equal(autoDebounced(now - AUTO_DEBOUNCE_MS - 1, now), false);
});

test('retainAutoDebounce: a completed run (delivered or nothing-new) holds the 10-min debounce', () => {
  assert.equal(retainAutoDebounce('done'), true);
});

test('retainAutoDebounce: a transient/auth failure releases it so the next login retries at once', () => {
  // The auto-run can fire on the login page before the session exists (csrf/prelude 400), or hit an
  // anti-bot challenge, or find no captured session yet. None of these may burn the debounce, or the
  // retry after the user actually authenticates is suppressed for 10 minutes.
  for (const s of ['error', 'challenged', 'nosession']) {
    assert.equal(retainAutoDebounce(s), false, `status ${s} must release the debounce`);
  }
});
