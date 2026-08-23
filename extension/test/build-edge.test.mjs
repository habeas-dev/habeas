import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { edgeManifest } from '../../scripts/build-edge.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const shipped = () => JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'));

// Edge rejected the shared package on exactly two counts. Both come from the manifest deliberately
// serving three browsers at once, so the fix is a separate build — never edits to the shared manifest,
// which would cost Firefox its background script.

test('the Edge manifest drops the two fields Edge refuses', () => {
  const m = edgeManifest(shipped());
  assert.ok(!('key' in m), 'Edge rejects a manifest containing key');
  assert.ok(!('scripts' in m.background), 'Edge rejects background.scripts with manifest_version 3');
});

test('…and keeps the background it actually runs on', () => {
  const m = edgeManifest(shipped());
  assert.equal(m.background.service_worker, 'src/background.js');
  assert.equal(m.background.type, 'module');
});

test('a manifest with no service worker is refused rather than shipped headless', () => {
  const broken = shipped();
  delete broken.background.service_worker;
  assert.throws(() => edgeManifest(broken), /service_worker/);
});

test('the shared manifest is left untouched — Firefox still needs what Edge refuses', () => {
  const before = JSON.stringify(shipped());
  edgeManifest(shipped());
  assert.equal(JSON.stringify(shipped()), before);
  const m = shipped();
  assert.ok(m.background.scripts, 'Firefox lost background.scripts');
  assert.ok(m.key, 'the Chrome id is derived from key; losing it would change the OAuth redirect');
});

test('Firefox-only metadata is not shipped to Edge', () => {
  assert.ok(!('browser_specific_settings' in edgeManifest(shipped())));
});
