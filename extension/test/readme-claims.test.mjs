import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sources = () => readdirSync(join(ROOT, 'sources-repo/sources'))
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources', f), 'utf8')));

// The README is the landing page for anything that links to the repo, and its numbers go stale silently
// every time the catalogue moves. Worse, it names services — and naming an EXPERIMENTAL one as if it
// were tested is the kind of claim that costs trust rather than a correction.

test('the README counts match the catalogue', () => {
  const all = sources();
  const verified = all.filter((s) => !s.beta).length;
  const beta = all.length - verified;
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(`${verified} verified Sources are published today`),
    `README does not say ${verified} verified Sources — the catalogue moved`);
  assert.ok(readme.includes(`A further ${beta} are published as **experimental**`),
    `README does not say ${beta} experimental`);
  assert.ok(readme.includes(`**${verified} verified Sources**`), 'the status list is out of date');
});

test('every service the README names is published and NOT experimental', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const all = sources();
  const named = { Revolut: 'revolut', Amazon: 'amazon', PayPal: 'paypal', 'Trade Republic': 'traderepublic',
    AliExpress: 'aliexpress', Raisin: 'raisin', Hover: 'hover-com' };
  for (const [label, id] of Object.entries(named)) {
    if (!readme.includes(label)) continue;                 // dropped from the copy — fine
    const src = all.find((s) => s.id === id);
    assert.ok(src, `README names ${label}, which is not in the catalogue`);
    assert.ok(!src.beta, `README names ${label} as if it were tested, but it is experimental`);
  }
  // …and the experimental ones must not be named as if they worked.
  for (const s of all.filter((x) => x.beta)) {
    const label = (s.name || '').split('—')[0].trim();
    if (label.length > 3) {
      assert.ok(!readme.includes(label), `README names ${label}, which is experimental`);
    }
  }
});
