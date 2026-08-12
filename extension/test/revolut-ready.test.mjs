import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isReadyNavigation } from '../src/lib/autosync.js';
import { validateAdapter } from '../src/adapters/validate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const revolut = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/revolut.json'), 'utf8'));

test('the published Revolut source is still valid', () => {
  const v = validateAdapter(revolut);
  assert.ok(v.ok, `invalid: ${(v.errors || []).join('; ')}`);
});

test('auto-sync waits for the home view, and does not fire on the screens before it', () => {
  assert.equal(isReadyNavigation(revolut, 'https://app.revolut.com/home'), true);
  assert.equal(isReadyNavigation(revolut, 'https://app.revolut.com/home/accounts'), true, 'a sub-view of home is still home');
  assert.equal(isReadyNavigation(revolut, 'https://app.revolut.com/start'), false);
  assert.equal(isReadyNavigation(revolut, 'https://app.revolut.com/'), false);
  // A declared gate with no visible URL must wait rather than fire early.
  assert.equal(isReadyNavigation(revolut, ''), false);
});

test('the gate is scoped to Revolut’s own host', () => {
  assert.equal(isReadyNavigation(revolut, 'https://app.revolut.test/home'), false);
});
