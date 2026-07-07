import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  assert.match(html, /data-i18n="flow_h"/);
  assert.match(html, /data-i18n="flow_step_source"/);
  assert.match(html, /data-i18n="flow_step_runtime"/);
  assert.match(html, /data-i18n="flow_step_sink"/);
  assert.match(html, /data-i18n="source_defs_h2"/);
  assert.match(html, /data-i18n="recorder_h2"/);
  assert.match(html, /data-i18n="dev_h2"/);
  assert.match(html, /class="compare-table"/);
  assert.match(html, /<a href="\/sources\.html" data-i18n="sources_cta"><\/a>/);
  assert.match(html, /<a href="\/why-habeas\.html" data-i18n="nav_why">Why Habeas\?<\/a>/);
  assert.match(html, /<a href="\/architecture" data-i18n="nav_architecture">Architecture<\/a>/);
});

test('landing page i18n keys exist in both languages', async () => {
  const { html, i18n } = await loadLanding();
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);

  for (const lang of ['en', 'es']) {
    for (const key of keys) {
      assert.ok(i18n[lang][key], `missing ${lang}.${key}`);
    }
  }

  assert.equal(i18n.en.title, 'Habeas — export your own data from your own session');
  assert.equal(i18n.en.hero_h1, 'Export your own data.');
  assert.equal(i18n.en.nav_why, 'Why Habeas?');
  assert.equal(i18n.en.nav_architecture, 'Architecture');
  assert.equal(i18n.es.why_h2, 'Por qué Habeas es diferente');
  assert.equal(i18n.es.nav_why, 'Por qué Habeas');
  assert.equal(i18n.es.nav_architecture, 'Arquitectura');
  assert.equal(i18n.es.hero_h1, 'Exporta tus propios datos.');
});

test('architecture page is public and renders the canonical ARCHITECTURE.md source', async () => {
  const [html, indexHtml, privacyHtml, sourcesHtml, termsHtml, whyHtml] = await Promise.all([
    fs.readFile(path.join(docsDir, 'architecture/index.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'index.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'privacy.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'sources.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'terms.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'why-habeas.html'), 'utf8'),
  ]);

  assert.match(html, /<title>Habeas Architecture<\/title>/);
  assert.match(html, /<meta name="description" content="Technical architecture and design principles behind Habeas\." \/>/);
  assert.match(html, /<meta property="og:title" content="Habeas Architecture" \/>/);
  assert.match(html, /<meta property="og:description" content="Technical architecture and design principles behind Habeas\." \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/habeas\.dev\/architecture" \/>/);
  assert.match(html, /const ARCHITECTURE_MD_URL = 'https:\/\/raw\.githubusercontent\.com\/habeas-dev\/habeas\/main\/ARCHITECTURE\.md';/);
  assert.match(html, /const MARKDOWN_RENDER_URL = 'https:\/\/api\.github\.com\/markdown';/);
  assert.match(html, /mode:\s*'gfm'/);
  assert.match(html, /context:\s*'habeas-dev\/habeas'/);
  assert.match(html, /id="architecture-content"/);
  assert.match(html, /Loading ARCHITECTURE\.md…/);

  for (const page of [indexHtml, privacyHtml, sourcesHtml, termsHtml, whyHtml]) {
    assert.match(page, /href="\/architecture"/);
  }
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
