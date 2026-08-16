import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { globSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const guides = () => globSync('docs/{download,es/descargar}/*.html', { cwd: ROOT }).filter((f) => !f.endsWith('index.html'));

// The guide pages are the ones an assistant would cite — they answer the question verbatim ("how do I
// download my X invoices"). What they declare about themselves is the difference between being quoted and
// being paraphrased into something wrong, so it is worth pinning.

test('every guide declares its FAQ and its procedure', () => {
  const files = guides();
  assert.ok(files.length >= 20, `expected the generated guides, found ${files.length}`);
  for (const f of files) {
    const h = read(f);
    assert.match(h, /"@type": "FAQPage"/, `${f}: no FAQPage`);
    assert.match(h, /"@type": "HowTo"/, `${f}: no HowTo`);
    assert.match(h, /"@type": "HowToStep"/, `${f}: HowTo with no steps`);
  }
});

test('the steps are marked up as ordered, because they are', () => {
  const h = read(guides()[0]);
  assert.match(h, /<ol>[\s\S]*?<li>[\s\S]*?<\/ol>/, 'the procedure is still an unordered list');
});

test('every JSON-LD block on every guide actually parses', () => {
  // A block that does not parse is worse than no block: it is silently ignored by everything.
  for (const f of guides()) {
    for (const m of read(f).matchAll(/<script type="application\/ld\+json">\s*(\{[\s\S]*?\})\s*<\/script>/g)) {
      assert.doesNotThrow(() => JSON.parse(m[1]), `${f}: invalid JSON-LD`);
    }
  }
});

test('the guide indexes declare what they list', () => {
  for (const f of ['docs/download/index.html', 'docs/es/descargar/index.html']) {
    const h = read(f);
    assert.match(h, /"@type": "ItemList"/, `${f}: no ItemList`);
    assert.match(h, /"@type": "ListItem"/, `${f}: an ItemList with no items`);
  }
});

test('llms.txt exists, is current, and says what Habeas is NOT', () => {
  assert.ok(existsSync(join(ROOT, 'docs/llms.txt')), 'docs/llms.txt is missing');
  const txt = read('docs/llms.txt');
  // The limits are the load-bearing part: without them an assistant describes this as a scraper or an
  // aggregator, which is precisely the confusion the whole project exists to avoid.
  assert.match(txt, /## What it is NOT/);
  for (const claim of [/never asks for, stores or transmits any password/, /Not an aggregator/, /eTLD\+1/]) {
    assert.match(txt, claim, `llms.txt no longer states: ${claim}`);
  }
});

test('crawlers are not blocked', () => {
  const robots = read('docs/robots.txt');
  assert.ok(!/^\s*Disallow:\s*\/\s*$/m.test(robots), 'robots.txt disallows the whole site');
  assert.match(robots, /Sitemap:/);
});
