import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateAdapter } from '../../sources-repo/scripts/validate.js';

// A source version that ships without a changelog entry fails quietly and expensively: the catalog
// serves the new version, the guide page on habeas.dev renders the history, and the history stops one
// entry short — so the page shows a version whose change is undocumented, while an older entry
// describing the OLD behaviour keeps standing as though it were still true. That happened to Revolut:
// 2026-08-26.5 changed which field the amount comes from, and the newest note still said the weekend
// currency surcharge was documented rather than fixed.
//
// The registry's own validator enforces this, but its CI only runs AFTER a push to the catalog — by
// which point the wrong bytes are already published, and a version identifies one content permanently.
// This test puts the same rule where it bites first: `npm test`, before anything leaves the machine.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = join(ROOT, 'sources-repo', 'sources');
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => ({ file: f, a: JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));

test('every published version says what it changed', () => {
  assert.ok(sources.length >= 20, `expected the catalog, found ${sources.length} sources`);
  for (const { file, a } of sources) {
    if (!Array.isArray(a.changelog) || !a.changelog.length) continue;  // a brand-new source has nothing to report against
    const versions = a.changelog.map((e) => e && e.version);
    assert.ok(versions.includes(a.version),
      `${file}: version ${a.version} has no changelog entry (newest is ${versions[0]})`);
  }
});

test('a changelog note is written in both languages', () => {
  for (const { file, a } of sources) {
    for (const e of a.changelog || []) {
      const c = e && e.changes;
      assert.ok(c && typeof c.en === 'string' && c.en.trim(), `${file} ${e?.version}: no English note`);
      assert.ok(typeof c.es === 'string' && c.es.trim(), `${file} ${e?.version}: no Spanish note`);
    }
  }
});

test('the staged catalog passes the registry validator', () => {
  for (const { file, a } of sources) {
    const r = validateAdapter(a);
    assert.ok(r.ok, `${file}: ${(r.errors || []).join('; ')}`);
  }
});
