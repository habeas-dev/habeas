import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');
const docsDir = path.resolve(__dirname, '../../docs');
const sectionMarkers = [
  'id="sources-preview"',
  'problem_h2',
  'how_h2',
  'source_defs_h2',
  'recorder_h2',
  'why_h2',
  'dest_h2',
  'id="install"',
  'dev_h2',
  'oss_h2',
];

function createElement({ dataset = {}, hidden = false } = {}) {
  return {
    dataset,
    hidden,
    textContent: '',
    innerHTML: '',
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener() {},
  };
}

function createDocument() {
  const sourceSection = createElement({ hidden: true });
  const sourceCount = createElement();
  const sourceList = createElement();
  const i18nElements = [
    createElement({ dataset: { i18n: 'sources_h2' } }),
    createElement({ dataset: { i18n: 'sources_lead' } }),
    createElement({ dataset: { i18n: 'sources_cta' } }),
  ];
  const elements = {
    'sources-preview': sourceSection,
    'sources-preview-count': sourceCount,
    'sources-preview-list': sourceList,
  };

  return {
    documentElement: {},
    _listeners: {},
    addEventListener(type, listener) {
      this._listeners[type] = listener;
    },
    getElementById(id) {
      return elements[id] || null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return i18nElements;
      return [];
    },
    __i18nElements: i18nElements,
    __sourceSection: sourceSection,
    __sourceCount: sourceCount,
    __sourceList: sourceList,
  };
}

async function loadLanding({ fetchImpl } = {}) {
  const [html, script] = await Promise.all([
    fs.readFile(path.join(docsDir, 'index.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'i18n.js'), 'utf8'),
  ]);

  const document = createDocument();
  const context = {
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { language: 'en' },
    document,
    fetch: fetchImpl || (() => Promise.reject(new Error('unexpected fetch'))),
    globalThis: {},
    console: { debug() {} },
  };
  context.globalThis = context;
  vm.runInNewContext(`${script}\nglobalThis.__I18N = I18N;`, context);
  return { html, i18n: context.__I18N, context, document };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

function createMockSources(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `source-${index + 1}`,
    name: `Source ${index + 1}`,
    service: `Service ${index + 1}`,
    country: index % 2 === 0 ? 'es' : 'global',
  }));
}

test('landing page keeps the new information hierarchy', async () => {
  const [{ html }, css] = await Promise.all([
    loadLanding(),
    fs.readFile(path.join(docsDir, 'style.css'), 'utf8'),
  ]);
  const positions = sectionMarkers.map((marker) => html.indexOf(marker));

  let previousPosition = -1;
  sectionMarkers.forEach((marker, index) => {
    const position = positions[index];
    assert.notEqual(position, -1, `missing section marker '${marker}'`);
    assert.ok(previousPosition < position, `section marker '${marker}' should come after the previous section`);
    previousPosition = position;
  });

  assert.doesNotMatch(html, /data-i18n="hero_note"/);
  assert.match(html, /class="hero-bg-logo"/);
  assert.match(html, /class="feature-strip"/);
  assert.equal((html.match(/class="feature-pill"/g) || []).length, 4);
  assert.match(css, /\.feature-pill:empty\s*\{[^}]*display\s*:\s*none/);
  assert.match(css, /\.hero \.hero-bg-logo\s*\{[^}]*opacity\s*:\s*\.08/);
  assert.match(css, /\.hero \.cta \.btn\.ghost\s*\{[^}]*border-color\s*:\s*rgba\(255,255,255,\s*\.38\)/);
  assert.match(css, /\.hero \.cta \.btn\.ghost\s*\{[^}]*background\s*:\s*rgba\(255,255,255,\s*\.08\)/);
  assert.match(css, /\.hero \.cta \.btn\.ghost:hover\s*\{[^}]*border-color\s*:\s*rgba\(255,255,255,\s*\.5\)/);
  assert.match(css, /\.hero \.cta \.btn\.ghost:hover\s*\{[^}]*background\s*:\s*rgba\(255,255,255,\s*\.14\)/);
  assert.match(css, /\.compare-table\s*\{[^}]*table-layout\s*:\s*fixed/);
  assert.match(css, /\.compare-table thead th:nth-child\(2\), \.compare-table thead th:nth-child\(3\)\s*\{[^}]*width\s*:\s*32%/);
  assert.match(html, /data-i18n="flow_h"/);
  assert.match(html, /data-i18n="flow_step_source"/);
  assert.match(html, /data-i18n="flow_step_runtime"/);
  assert.match(html, /data-i18n="flow_step_sink"/);
  assert.match(html, /data-i18n="source_defs_h2"/);
  assert.match(html, /data-i18n="recorder_h2"/);
  assert.match(html, /data-i18n="dev_h2"/);
  assert.match(html, /class="compare-table"/);
  assert.match(html, /<a href="\/sources\.html" data-i18n="sources_cta">View all supported sources →<\/a>/);
  assert.match(html, /<a href="\/why-habeas\.html" data-i18n="nav_why">Why Habeas\?<\/a>/);
  assert.match(html, /<a href="\/architecture\.html" data-i18n="nav_architecture">Architecture<\/a>/);
});

test('landing page i18n keys exist in both languages', async () => {
  const { html, i18n } = await loadLanding();
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);

  for (const lang of ['en', 'es']) {
    for (const key of keys) {
      assert.ok(i18n[lang][key], `missing ${lang}.${key}`);
    }
  }

  assert.equal(i18n.en.title, 'Download your receipts, invoices and bank statements — Habeas');
  assert.equal(i18n.en.hero_h1, 'Download your receipts, invoices and statements.');
  assert.equal(i18n.en.nav_why, 'Why Habeas?');
  assert.equal(i18n.en.nav_architecture, 'Architecture');
  assert.equal(i18n.es.why_h2, 'Por qué Habeas es diferente');
  assert.equal(i18n.es.nav_why, 'Por qué Habeas');
  assert.equal(i18n.es.nav_architecture, 'Arquitectura');
  assert.equal(i18n.es.hero_h1, 'Descarga tus tickets, facturas y extractos.');
});

test('the headline is written for what people search, not for the brand', async () => {
  const { i18n } = await loadLanding();
  // The page ranked for nothing because its title and H1 described the product in the abstract
  // ("Export your own data") — words nobody types. These assert the intent behind the current copy
  // so a future rewrite that drops the search terms fails loudly instead of silently costing reach.
  const wanted = {
    en: [/receipts?/i, /invoices?/i, /statements?/i],
    es: [/tickets?/i, /facturas?/i, /extractos?/i],
  };
  for (const [lang, patterns] of Object.entries(wanted)) {
    for (const re of patterns) {
      assert.match(i18n[lang].hero_h1, re, `${lang}.hero_h1 lost ${re}`);
      assert.match(i18n[lang].title, re, `${lang}.title lost ${re}`);
    }
    // Google truncates titles around 60 characters; past that the tail is wasted.
    assert.ok(i18n[lang].title.length <= 62, `${lang}.title is ${i18n[lang].title.length} chars, too long for a SERP`);
    // Brand-first titles bury the terms people actually search for.
    assert.ok(!i18n[lang].title.startsWith('Habeas'), `${lang}.title leads with the brand`);
  }
});

test('architecture page is public and renders the canonical ARCHITECTURE.md source', async () => {
  const [architectureHtml, architectureEsMarkdown, indexHtml, privacyHtml, sourcesHtml, termsHtml, whyHtml] = await Promise.all([
    fs.readFile(path.join(docsDir, 'architecture.html'), 'utf8'),
    fs.readFile(path.join(rootDir, 'ARCHITECTURE.es.md'), 'utf8'),
    fs.readFile(path.join(docsDir, 'index.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'privacy.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'sources.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'terms.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'why-habeas.html'), 'utf8'),
  ]);

  assert.match(architectureHtml, /<title>Habeas Architecture<\/title>/);
  assert.match(architectureHtml, /<meta name="description" content="Technical architecture and design principles behind Habeas\." \/>/);
  assert.match(architectureHtml, /<meta property="og:title" content="Habeas Architecture" \/>/);
  assert.match(architectureHtml, /<meta property="og:description" content="Technical architecture and design principles behind Habeas\." \/>/);
  assert.match(architectureHtml, /<link rel="canonical" href="https:\/\/habeas\.dev\/architecture\.html" \/>/);
  assert.match(architectureHtml, /const ARCHITECTURE_MD_URL_EN = 'https:\/\/raw\.githubusercontent\.com\/habeas-dev\/habeas\/main\/ARCHITECTURE\.md';/);
  assert.match(architectureHtml, /const ARCHITECTURE_MD_URL_ES = 'https:\/\/raw\.githubusercontent\.com\/habeas-dev\/habeas\/main\/ARCHITECTURE\.es\.md';/);
  assert.match(architectureHtml, /const MARKDOWN_RENDER_URL = 'https:\/\/api\.github\.com\/markdown';/);
  assert.match(architectureHtml, /mode:\s*'gfm'/);
  assert.match(architectureHtml, /context:\s*'habeas-dev\/habeas'/);
  assert.match(architectureHtml, /id="architecture-content"/);
  assert.match(architectureHtml, /Loading architecture…/);
  assert.match(architectureHtml, /class="langswitch"/);
  assert.match(architectureHtml, /data-lang="en"/);
  assert.match(architectureHtml, /data-lang="es"/);
  assert.match(architectureEsMarkdown, /^# Arquitectura de Habeas/m);

  for (const page of [indexHtml, privacyHtml, sourcesHtml, termsHtml, whyHtml]) {
    assert.match(page, /href="\/architecture\.html"/);
  }
});

test('secondary pages share a coherent top navigation menu', async () => {
  const [architectureHtml, privacyHtml, sourcesHtml, termsHtml, whyHtml, navI18n] = await Promise.all([
    fs.readFile(path.join(docsDir, 'architecture.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'privacy.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'sources.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'terms.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'why-habeas.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'nav-i18n.js'), 'utf8'),
  ]);
  const pages = [architectureHtml, privacyHtml, sourcesHtml, termsHtml, whyHtml];
  const navLinks = [
    'href="/"',
    'href="/why-habeas.html"',
    'href="/sources.html"',
    'href="/architecture.html"',
    'href="/privacy.html"',
    'href="/terms.html"',
    'href="https://github.com/habeas-dev/habeas"',
  ];

  for (const html of pages) {
    for (const link of navLinks) {
      assert.ok(html.includes(link), `missing nav link ${link}`);
    }
    assert.match(html, /class="langswitch"/);
    assert.match(html, /<script src="nav-i18n\.js"><\/script>/);
    assert.match(html, /habeasApplyTopNavLanguage\?\.\(/);
  }
  assert.match(navI18n, /'\/': 'Inicio'/);
  assert.match(navI18n, /langswitch: 'Idioma'/);
});

test('landing page ships its copy in the HTML, not only after JS runs', async () => {
  const { html } = await loadLanding();
  // Every [data-i18n] slot used to be an empty shell filled in at runtime, which left the served
  // document with a few hundred characters of text. docs/tools/prerender-home.mjs bakes the English
  // copy in; this guards against it silently regressing (e.g. a new section added by hand).
  const empty = html.match(/data-i18n="([^"]+)"><\//g) || [];
  assert.deepEqual(empty, [], `empty [data-i18n] slots found: ${empty.join(', ')}`);

  const visibleText = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ').trim();
  assert.ok(visibleText.length > 4000, `landing carries only ${visibleText.length} chars of text in its HTML`);
});

test('every public page carries social and structured metadata', async () => {
  const pages = ['index.html', 'why-habeas.html', 'sources.html', 'architecture.html', 'privacy.html', 'terms.html'];
  for (const page of pages) {
    const html = await fs.readFile(path.join(docsDir, page), 'utf8');
    assert.match(html, /<meta property="og:image" content="https:\/\/habeas\.dev\/og-image\.png"/, `${page}: no og:image`);
    assert.match(html, /<meta property="og:url" content="https:\/\/habeas\.dev\//, `${page}: no og:url`);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image"/, `${page}: no twitter card`);
  }
  // JSON-LD must parse — a malformed block is worse than none, Google discards the whole page's data.
  for (const page of ['index.html', 'why-habeas.html', 'es/por-que-habeas.html']) {
    const html = await fs.readFile(path.join(docsDir, page), 'utf8');
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(block, `${page}: no JSON-LD block`);
    const data = JSON.parse(block[1]);
    assert.equal(data['@context'], 'https://schema.org', `${page}: wrong @context`);
  }
});

test('why-habeas is split into one indexable URL per language, linked by hreflang', async () => {
  const [en, es] = await Promise.all([
    fs.readFile(path.join(docsDir, 'why-habeas.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'es', 'por-que-habeas.html'), 'utf8'),
  ]);
  // Neither page may carry the other language's copy: that was the duplicate-content problem.
  assert.doesNotMatch(en, /data-lang-content/, 'English page still holds a hidden language block');
  assert.doesNotMatch(es, /data-lang-content/, 'Spanish page still holds a hidden language block');
  assert.match(en, /<html lang="en">/);
  assert.match(es, /<html lang="es">/);
  assert.match(es, /<link rel="canonical" href="https:\/\/habeas\.dev\/es\/por-que-habeas\.html"/);

  for (const [page, html] of [['en', en], ['es', es]]) {
    assert.match(html, /hreflang="en" href="https:\/\/habeas\.dev\/why-habeas\.html"/, `${page}: no en alternate`);
    assert.match(html, /hreflang="es" href="https:\/\/habeas\.dev\/es\/por-que-habeas\.html"/, `${page}: no es alternate`);
    assert.match(html, /hreflang="x-default"/, `${page}: no x-default`);
  }
});

test('robots.txt allows crawling and points at the sitemap', async () => {
  const robots = await fs.readFile(path.join(docsDir, 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/habeas\.dev\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
});

test('sitemap includes all public website pages', async () => {
  const sitemap = await fs.readFile(path.join(docsDir, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);

  // Derive the expected set from the pages actually on disk rather than a hand-kept list, which
  // silently goes stale — every generated source page would otherwise have to be added by hand.
  const skipDirs = new Set(['tools', 'fonts', 'logos']);
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const found = [];
    for (const e of entries) {
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) found.push(...await walk(path.join(dir, e.name))); }
      else if (e.name.endsWith('.html')) found.push(path.join(dir, e.name));
    }
    return found;
  }
  const files = await walk(docsDir);
  const expected = [];
  for (const file of files) {
    const html = await fs.readFile(file, 'utf8');
    if (/<meta\s+name="robots"[^>]*noindex/i.test(html)) continue;   // OAuth callbacks etc.
    const rel = path.relative(docsDir, file).split(path.sep).join('/');
    expected.push(`https://habeas.dev/${rel.replace(/(^|\/)index\.html$/, '$1')}`);
  }

  assert.ok(expected.length > 0, 'no indexable pages found');
  for (const url of expected) {
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), `sitemap is missing ${url} — re-run docs/tools/build-sitemap.mjs`);
  }
  assert.equal((sitemap.match(/<loc>/g) || []).length, expected.length, 'sitemap holds URLs with no page behind them');
  // Every entry needs a lastmod; without it Google has no signal that a page changed.
  assert.equal((sitemap.match(/<lastmod>/g) || []).length, expected.length);
});

test('why habeas page is public, discoverable, and has concise philosophy content', async () => {
  const [html, indexHtml, privacyHtml, sourcesHtml, termsHtml] = await Promise.all([
    fs.readFile(path.join(docsDir, 'why-habeas.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'index.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'privacy.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'sources.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'terms.html'), 'utf8'),
  ]);

  assert.match(html, /<title>Why Habeas\? — user control, privacy, and data sovereignty<\/title>/);
  assert.match(html, /<meta name="description" content="Why Habeas exists: to help people keep their own receipts, invoices, statements, and reports without handing control or credentials to another intermediary\." \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/habeas\.dev\/why-habeas\.html" \/>/);
  assert.match(html, /<meta property="og:title" content="Why Habeas\? — user control, privacy, and data sovereignty" \/>/);
  assert.match(html, /<h1>Why Habeas\?<\/h1>/);
  assert.match(html, /What problem does Habeas solve\?/);
  assert.match(html, /Why isn't data portability already enough\?/);
  assert.match(html, /Why should users have direct control\?/);
  assert.match(html, /What principles guide Habeas\?/);
  assert.match(html, /Why does the architecture follow these principles\?/);
  assert.match(html, /Data sovereignty/);
  assert.match(html, /Privacy by design/);
  assert.match(html, /trust is earned through architecture, not requested through a password prompt/i);
  assert.match(html, /<a href="\/">Home<\/a>/);
  assert.match(html, /<a href="\/sources\.html">Sources<\/a>/);
  assert.match(html, /<a href="\/privacy\.html">Privacy<\/a>/);

  for (const page of [indexHtml, privacyHtml, sourcesHtml, termsHtml]) {
    assert.match(page, /href="\/why-habeas\.html"/);
  }
});

test('landing page loads a compact localized source preview from the catalog index only', async () => {
  const fetchCalls = [];
  const sources = createMockSources(9);
  const { context, document } = await loadLanding({
    fetchImpl: (url) => {
      fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sources }),
      });
    },
  });

  document._listeners.DOMContentLoaded();
  await flushAsyncWork();

  assert.deepEqual(fetchCalls, ['https://habeas-dev.github.io/sources/index.json']);
  assert.equal(document.__sourceSection.hidden, false);
  assert.equal(document.__sourceCount.textContent, 'Currently supports 9 sources');
  assert.equal((document.__sourceList.innerHTML.match(/class="src"/g) || []).length, 8);
  assert.match(document.__sourceList.innerHTML, /Source \d+/);
  assert.match(document.__sourceList.innerHTML, /Service \d+/);

  context.setLang('es');
  assert.equal(document.__sourceCount.textContent, 'Actualmente soporta 9 fuentes');
});

test('landing page omits the source preview when the catalog cannot be loaded', async () => {
  const { document } = await loadLanding({
    fetchImpl: () => Promise.reject(new Error('offline')),
  });

  document._listeners.DOMContentLoaded();
  await flushAsyncWork();

  assert.equal(document.__sourceSection.hidden, true);
  assert.equal(document.__sourceCount.textContent, '');
  assert.equal(document.__sourceList.innerHTML, '');
});

test('per-source landing pages are generated only where there is curated copy', async () => {
  const copies = JSON.parse(await fs.readFile(path.join(docsDir, 'source-pages.es.json'), 'utf8'));
  const ids = Object.keys(copies).filter((k) => !k.startsWith('_'));
  const dir = path.join(docsDir, 'es', 'descargar');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.html'));

  // One page per curated entry, and no orphans: a page with no copy behind it would be the
  // template-spun doorway content this generator exists to avoid.
  assert.equal(files.length, ids.length, 'page count does not match curated entries');
  for (const id of ids) {
    assert.ok(copies[id].slug, `${id}: no slug`);
    assert.ok(files.includes(`${copies[id].slug}.html`), `${id}: no page for slug ${copies[id].slug}`);
  }

  const slugs = new Set(ids.map((id) => copies[id].slug));
  assert.equal(slugs.size, ids.length, 'two sources share a slug');
});

test('each source page is substantive, self-describing and correctly marked up', async () => {
  const dir = path.join(docsDir, 'es', 'descargar');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.html'));
  const intros = new Set();

  for (const file of files) {
    const html = await fs.readFile(path.join(dir, file), 'utf8');
    const url = `https://habeas.dev/es/descargar/${file.replace(/\.html$/, '')}`;

    assert.match(html, /<html lang="es">/, `${file}: not marked as Spanish`);
    assert.equal((html.match(/<h1/g) || []).length, 1, `${file}: needs exactly one h1`);
    assert.ok(html.includes(`<link rel="canonical" href="${url}"`), `${file}: canonical does not match its path`);
    assert.match(html, /data-umami-event="install"[^>]*data-umami-event-source="/, `${file}: install CTA not attributed`);

    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(block, `${file}: no JSON-LD`);
    assert.equal(JSON.parse(block[1])['@type'], 'FAQPage', `${file}: JSON-LD is not a FAQPage`);

    const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ').trim();
    assert.ok(text.length > 1500, `${file}: only ${text.length} chars — too thin to be worth indexing`);

    // The opening paragraph must be about that service, not boilerplate shared across pages.
    const intro = html.match(/<p class="lead">(.*?)<\/p>/s)?.[1];
    assert.ok(intro, `${file}: no intro`);
    assert.ok(!intros.has(intro), `${file}: its intro is duplicated from another page`);
    intros.add(intro);
  }
});

test('the catalog links to every generated source page', async () => {
  const copies = JSON.parse(await fs.readFile(path.join(docsDir, 'source-pages.es.json'), 'utf8'));
  const sources = await fs.readFile(path.join(docsDir, 'sources.html'), 'utf8');
  for (const [id, copy] of Object.entries(copies)) {
    if (id.startsWith('_')) continue;
    assert.ok(sources.includes(`/es/descargar/${copy.slug}`), `sources.html does not link ${copy.slug}`);
  }
});
