import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Chrome resolves setIcon paths against the extension root; Firefox resolves them against the calling
// DOCUMENT. Every caller of applyThemeIcon lives in src/ui/, so a relative 'icon-16.png' resolved to
// 'src/ui/icon-16.png' there — which does not exist — and Firefox drew a blank toolbar icon.

test('every icon setIcon can be given is root-absolute and actually exists', () => {
  const src = readFileSync(join(ROOT, 'src/lib/theme-icon.js'), 'utf8');
  const paths = [...src.matchAll(/\d+:\s*'([^']+\.png)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 6, `expected the light and dark icon sets, found ${paths.length}`);
  for (const p of paths) {
    assert.ok(p.startsWith('/'), `${p} is relative — Firefox resolves it against src/ui/, not the root`);
    assert.ok(existsSync(join(ROOT, p.slice(1))), `${p} does not exist in the packaged extension`);
  }
});

test('the callers really are outside the extension root, which is why this matters', () => {
  const callers = readdirSync(join(ROOT, 'src/ui'))
    .filter((f) => f.endsWith('.js') && /watchThemeIcon|applyThemeIcon/.test(readFileSync(join(ROOT, 'src/ui', f), 'utf8')));
  assert.ok(callers.length > 0, 'no caller found in src/ui — if the icon moved, revisit this rule');
});
