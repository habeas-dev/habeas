#!/usr/bin/env node
// Generate docs/source-rank.js from extension/src/lib/region.js.
//
// The same ranking decides what the landing previews and what the in-extension marketplace lists. Two
// copies would drift, and the failure mode is silent: a visitor convinced by the site would install and
// then be shown an alphabetical wall of sources from someone else's country. So there is one
// implementation and this copies it, appending the small bit the page needs (i18n.js is a classic script
// and picks the helper up off globalThis).
//
//   node docs/tools/build-source-rank.mjs           # write
//   node docs/tools/build-source-rank.mjs --check   # fail if out of date (CI / npm test)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'extension/src/lib/region.js');
const OUT = join(ROOT, 'docs/source-rank.js');

const HEADER = `// GENERATED — do not edit. Source: extension/src/lib/region.js
// Regenerate with: node docs/tools/build-source-rank.mjs
`;
const FOOTER = `
// i18n.js is a classic script, so it reads the helper from here. If this file ever fails to load, the
// preview falls back to the plain random sample rather than rendering nothing.
globalThis.habeasSourceRank = { detectRegion, rankSources };
`;

export function build() {
  return HEADER + readFileSync(SRC, 'utf8').replace(/\s*$/, '\n') + FOOTER;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = build();
  if (process.argv.includes('--check')) {
    let have = '';
    try { have = readFileSync(OUT, 'utf8'); } catch (e) {}
    if (have !== want) {
      console.error('docs/source-rank.js is out of date — run: node docs/tools/build-source-rank.mjs');
      process.exit(1);
    }
    console.log('docs/source-rank.js is up to date');
  } else {
    writeFileSync(OUT, want);
    console.log(`wrote docs/source-rank.js (${want.length} bytes)`);
  }
}
