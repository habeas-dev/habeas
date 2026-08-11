import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// bridge.js relays page-side samples to the background by ENUMERATING fields, so a field added in
// hook.js silently never arrives — which is exactly what happened to `at` (leaving the throttle
// inference permanently dead) and would have happened to `cred`. This asserts the two lists agree.

test('every field hook.js puts on a sample is relayed by bridge.js', () => {
  const hook = readFileSync(join(ROOT, 'src/content/hook.js'), 'utf8');
  const bridge = readFileSync(join(ROOT, 'src/content/bridge.js'), 'utf8');

  const posted = new Set();
  for (const m of hook.matchAll(/type: 'sample',([^}]*)\}/g)) {
    for (const f of m[1].matchAll(/(?:^|[\s,{])([a-zA-Z_$][\w$]*)\s*:/g)) posted.add(f[1]);
  }
  posted.delete('type');
  // Deliberately not relayed: the bridge sends `domain` for the whole page instead, and every consumer
  // derives the host from the sample's own URL.
  posted.delete('host');
  posted.delete('path');
  assert.ok(posted.size > 5, `expected to find the sample fields, got ${[...posted]}`);

  const relayLine = bridge.split('\n').find((l) => l.includes("d.type === 'sample'"));
  assert.ok(relayLine, 'bridge.js no longer has a sample relay line — update this test');

  const missing = [...posted].filter((f) => !new RegExp(`\\b${f}\\s*:\\s*d\\.`).test(relayLine));
  assert.deepEqual(missing, [], `hook.js sends these but bridge.js drops them: ${missing.join(', ')}`);
});
