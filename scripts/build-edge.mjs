#!/usr/bin/env node
// Build the Edge Add-ons package.
//
// Edge validates the manifest more strictly than the other two stores, and rejects the shipped one on
// two counts:
//
//   background.scripts with manifest_version 3 — the manifest deliberately carries BOTH `service_worker`
//     (Chrome) and `scripts` (Firefox, which still needs it at our strict_min_version). Chrome ignores
//     the one it does not use and Firefox likewise; Edge refuses the package outright. So Edge gets its
//     own build with `scripts` removed — never the shared manifest, or Firefox loses its background.
//
//   key — Edge forbids it. That has a consequence worth knowing: the extension ID is derived from that
//     key, so WITHOUT it Edge assigns a different id, and `chrome.identity.getRedirectURL()` returns a
//     different `<id>.chromiumapp.org`. The Google OAuth client must have the Edge redirect registered
//     too, or Drive cannot connect there. The id is only knowable after the item exists, so that is a
//     step after the first submission, not before it.
//
//   node scripts/build-edge.mjs           # → dist/habeas-edge-<version>.zip
//   node scripts/build-edge.mjs --check   # print what would be stripped, write nothing
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The manifest Edge accepts: same extension, minus the two fields it refuses. Pure, so it is testable. */
export function edgeManifest(manifest) {
  const out = JSON.parse(JSON.stringify(manifest));
  delete out.key;                                   // Edge forbids it (and assigns its own id)
  if (out.background) {
    delete out.background.scripts;                  // MV3: service_worker only
    if (!out.background.service_worker) throw new Error('no background.service_worker — Edge would have no background');
  }
  // Firefox-only metadata is meaningless here and only invites questions at review.
  delete out.browser_specific_settings;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'));
  const edge = edgeManifest(manifest);
  if (process.argv.includes('--check')) {
    console.log('would strip: key, background.scripts, browser_specific_settings');
    console.log('background →', JSON.stringify(edge.background));
    process.exit(0);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'habeas-edge-'));
  try {
    cpSync(join(ROOT, 'extension'), join(tmp, 'extension'), { recursive: true });
    writeFileSync(join(tmp, 'extension/manifest.json'), JSON.stringify(edge, null, 2) + '\n');
    mkdirSync(join(ROOT, 'dist'), { recursive: true });
    execFileSync('npx', ['--yes', 'web-ext', 'build', '--source-dir', join(tmp, 'extension'),
      '--artifacts-dir', join(ROOT, 'dist/edge'), '--overwrite-dest', '--filename',
      `habeas-edge-${manifest.version}.zip`], { stdio: 'inherit' });
    console.log(`dist/edge/habeas-edge-${manifest.version}.zip`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
