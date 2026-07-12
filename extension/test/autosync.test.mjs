import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure scheduling policy for the background auto-sync runner — no chrome shim needed.
const { autoDebounced, retainAutoDebounce, AUTO_DEBOUNCE_MS } = await import('../src/lib/autosync.js');

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
