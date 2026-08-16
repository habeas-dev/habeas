import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Every permission the manifest requests needs a justification in the store listing's privacy tab, and a
// submission is blocked until they are all there. Four had drifted out of STORE.md — including activeTab,
// added in 0.9.13 — while `downloads` stayed documented long after it stopped being requested. That drift
// is invisible until a release will not submit, which is a bad moment to discover it.
test('every requested permission has a justification, and none is documented that is not requested', () => {
  const perms = new Set(JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8')).permissions);
  const doc = readFileSync(join(ROOT, 'STORE.md'), 'utf8');
  const table = /\| Permission \| Why.*?\n((?:\|.*\n)+)/.exec(doc);
  assert.ok(table, 'the permission-justification table is gone from STORE.md');
  const rows = new Set([...table[1].matchAll(/^\|\s*`([a-zA-Z_:]+)`/gm)].map((m) => m[1]));
  // host_permissions / optional_host_permissions are manifest keys, not entries in `permissions`.
  rows.delete('host_permissions'); rows.delete('optional_host_permissions');

  const missing = [...perms].filter((p) => !rows.has(p));
  assert.deepEqual(missing, [], `requested but not justified: ${missing.join(', ')}`);
  const stale = [...rows].filter((p) => !perms.has(p));
  assert.deepEqual(stale, [], `justified but no longer requested: ${stale.join(', ')}`);
});
