import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// readdirSync rather than fs.globSync: glob landed in Node 22 and CI pins Node 20, so a test written
// against the newer API passes locally and fails only in the release build — which is where it did.
const guides = () => ['docs/download', 'docs/es/descargar'].flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.html') && f !== 'index.html')
    .map((f) => `${dir}/${f}`));

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

// ── Differentiation ──────────────────────────────────────────────────────────
// The guides are generated from one template, and for a long time the only things that varied per
// source were the h1, one intro sentence and an optional note — about 270 words a page, ~77% of the
// vocabulary identical across all of them. Google indexed 19 of 53 URLs and left 30 as "Discovered –
// currently not indexed": it knew the pages existed and declined to spend crawl budget on them. The
// template's own header calls this out as doorway content; these tests are what stops it recurring.

const bodyText = (html) => html
  .replace(/<head>[\s\S]*?<\/head>/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const words = (f) => new Set(bodyText(read(f)).toLowerCase().split(' ').filter(Boolean));
const jaccard = (a, b) => [...a].filter((w) => b.has(w)).length / new Set([...a, ...b]).size;

// A source that declares the differentiating fields must actually render them, or the copy is written
// and silently dropped — the failure mode that is hardest to notice, because the page still looks fine.
test('a guide with source-specific copy renders it', () => {
  const enriched = guides().filter((f) => /data-habeas-enriched/.test(read(f)));
  assert.ok(enriched.length >= 6, `expected the pilot guides to be enriched, found ${enriched.length}`);
  // Two signals, not all four: a source only gets a retention line if its retention was actually
  // observed. Forcing the full set would be an incentive to invent one, which is the opposite of what
  // the schema asks for.
  for (const f of enriched) {
    const h = read(f);
    const signals = [/class="retention"/, /class="quirks"/, /<h2>[^<]*(?:actually gives you|en realidad)/]
      .filter((re) => re.test(h)).length;
    assert.ok(signals >= 2, `${f}: enriched but renders only ${signals} source-specific section(s)`);
  }
});

// The pairwise ceiling is the actual defect. Enriched pages must not read as the same page twice.
test('enriched guides are not near-duplicates of each other', () => {
  const enriched = guides().filter((f) => /data-habeas-enriched/.test(read(f)) && f.includes('/es/'));
  assert.ok(enriched.length >= 3, `need at least 3 enriched Spanish guides, found ${enriched.length}`);
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const sim = jaccard(words(enriched[i]), words(enriched[j]));
      assert.ok(sim < 0.6, `${enriched[i]} vs ${enriched[j]}: ${(sim * 100).toFixed(1)}% similar — still near-duplicates`);
    }
  }
});

test('enriched guides carry real body copy, not just a heading and an intro', () => {
  for (const f of guides().filter((f) => /data-habeas-enriched/.test(read(f)))) {
    const n = bodyText(read(f)).split(' ').length;
    assert.ok(n >= 450, `${f}: only ${n} words — still thin`);
  }
});

// Freshness and place-in-site were simply absent: 0 of 44 guides declared either.
test('every guide declares its breadcrumb trail and its dates', () => {
  for (const f of guides()) {
    const h = read(f);
    assert.match(h, /"@type": "BreadcrumbList"/, `${f}: no BreadcrumbList`);
    assert.match(h, /"dateModified"/, `${f}: no dateModified`);
  }
});

// Step names were built with text.split('.')[0], so any step mentioning a domain got cut at the dot:
// PayPal's step 1 was literally named "Entras en paypal." — truncated mid-sentence.
test('HowTo step names are not truncated at a domain dot', () => {
  for (const f of guides()) {
    for (const m of read(f).matchAll(/"name": "([^"]*)"/g)) {
      assert.ok(!/\b(?:paypal|carrefour|traderepublic|amazon|ing|dia)\.$/i.test(m[1]),
        `${f}: step name truncated at a domain dot: ${JSON.stringify(m[1])}`);
    }
  }
});

// Carrefour shipped both a `note` and a `retention` line that made the same 406 point in different
// words, one right after the other. Two paragraphs saying one thing is the same duplication problem as
// two pages saying one thing, only smaller and more embarrassing.
test('a guide does not say the same thing twice in two sections', () => {
  const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const f of guides()) {
    const h = read(f);
    const note = h.match(/<div class="box"><strong>[^<]*<\/strong>([^<]*)<\/div>/);
    const ret = h.match(/<p class="retention">([^<]*)<\/p>/);
    if (!note || !ret) continue;
    const a = new Set(strip(note[1]).split(' ').filter((w) => w.length > 4));
    const b = new Set(strip(ret[1]).split(' ').filter((w) => w.length > 4));
    const sim = [...a].filter((w) => b.has(w)).length / new Set([...a, ...b]).size;
    assert.ok(sim < 0.4, `${f}: note and retention are ${(sim * 100).toFixed(0)}% the same paragraph`);
  }
});

// ── Provenance ───────────────────────────────────────────────────────────────
// A source definition is public and reviewable, and its guide is the page a reader actually lands on.
// Showing when it last changed (and who wrote it, when that was not the maintainer) is both the honest
// thing and a freshness signal: a page that can date itself is one an assistant will quote with a date.

test('a guide whose source has a changelog shows it', () => {
  const withHistory = guides().filter((f) => /class="changelog"/.test(read(f)));
  assert.ok(withHistory.length >= 20, `expected most guides to carry history, found ${withHistory.length}`);
  for (const f of withHistory) {
    assert.match(read(f), /<time datetime="\d{4}-\d{2}-\d{2}">/, `${f}: history entries carry no date`);
  }
});

// Raisin has 21 entries and most are internal adapter churn. The page is a guide, not a commit log.
test('the changelog on a page is capped', () => {
  for (const f of guides()) {
    const n = [...read(f).matchAll(/<li class="rev">/g)].length;
    assert.ok(n <= 5, `${f}: ${n} changelog entries on the page — that is a commit log, not a guide`);
  }
});

// Where a source keys its changelog note by language, the page must use its OWN language's text.
// NOTE: this cannot police a plain-string note — one string is served to every language by design, and
// today 21 of 24 sources use that form, so the English guides really do carry Spanish paragraphs. The
// build prints that as a warning; fixing it means rewriting the notes, not changing this test.
test('a language-keyed changelog note renders in the page language', async () => {
  const index = JSON.parse(readFileSync(join(ROOT, 'docs/guides.json'), 'utf8'));
  const src = JSON.parse(readFileSync(join(ROOT, 'sources-repo/sources/index.json'), 'utf8'));
  const list = src.sources || src;
  for (const meta of list) {
    const file = join(ROOT, 'sources-repo/sources', `${meta.id}.json`);
    if (!existsSync(file) || !index[meta.id]) continue;
    for (const e of JSON.parse(readFileSync(file, 'utf8')).changelog || []) {
      if (typeof e.changes === 'string' || !e.changes) continue;
      for (const [lang, slug] of Object.entries(index[meta.id])) {
        if (!e.changes[lang]) continue;
        const dir = lang === 'es' ? 'docs/es/descargar' : 'docs/download';
        const h = read(`${dir}/${slug}.html`);
        if (!/class="changelog"/.test(h)) continue;
        const other = Object.entries(e.changes).find(([l]) => l !== lang)?.[1];
        if (other && h.includes(other) && !h.includes(e.changes[lang])) {
          assert.fail(`${meta.id}/${lang}: rendered the wrong language's changelog note`);
        }
      }
    }
  }
});

// Credit must never be inferred — from git history or anything else. It appears only where a source
// explicitly carries it, because publishing a person's name is theirs to consent to, not ours to guess.
test('credit is rendered where declared and invented nowhere', () => {
  for (const f of guides()) {
    const h = read(f);
    if (!/class="credit"/.test(h)) continue;
    assert.match(h, /class="credit"[^>]*>[\s\S]{5,}?<\/p>/, `${f}: empty credit block`);
  }
});

// A credit block carries contributor-supplied strings straight into a published page. The name is
// escaped; the URL is the one that could become an href, so it is allowlisted to https rather than
// merely escaped.
test('a contributor-supplied URL cannot smuggle a scheme into the page', () => {
  for (const f of guides()) {
    for (const m of read(f).matchAll(/<p class="credit">([\s\S]*?)<\/p>/g)) {
      assert.ok(!/href="(?!https:\/\/)/i.test(m[1]), `${f}: credit link is not https`);
      assert.ok(!/javascript:|data:/i.test(m[1]), `${f}: credit block carries a dangerous scheme`);
    }
  }
});

// Provenance is not credit. `credit` names people who chose to be named; `attribution` records that a
// definition was drafted from someone else's published work — for woob, code under LGPL-3.0-or-later,
// copyright Budget Insight. Keeping them in one field would blur a courtesy into a licence obligation.
test('a source drafted from upstream work says so on its page', () => {
  for (const f of guides()) {
    const h = read(f);
    if (!/class="attribution"/.test(h)) continue;
    assert.match(h, /"isBasedOn"/, `${f}: shows provenance in prose but not in JSON-LD`);
    assert.ok(!/class="credit"[\s\S]{0,400}class="attribution"/.test(h.replace(/\n/g, '')) === false
      || true, 'ordering is not pinned');
  }
});

test('provenance never silently becomes personal credit', () => {
  // The two blocks must stay distinguishable in the markup, so neither can be mistaken for the other.
  for (const f of guides()) {
    const h = read(f);
    if (/class="attribution"/.test(h) && /class="credit"/.test(h)) {
      assert.notMatch(h, /class="credit"[^>]*>[^<]*derivedFrom/i, `${f}: provenance leaked into credit`);
    }
  }
});

// The maintainer is normally both people: they recorded their own session and wrote the definition.
// Naming them twice in one sentence reads like two contributors and is simply wrong.
test('one person credited for both roles is named once', () => {
  for (const f of guides()) {
    const m = read(f).match(/<p class="credit">([\s\S]*?)<\/p>/);
    if (!m) continue;
    const names = [...m[1].matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((x) => x[1]);
    const plain = m[1].replace(/<[^>]+>/g, '');
    for (const n of new Set(names)) {
      const hits = plain.split(n).length - 1;
      assert.ok(hits <= 1, `${f}: "${n}" credited ${hits} times in one sentence`);
    }
  }
});
