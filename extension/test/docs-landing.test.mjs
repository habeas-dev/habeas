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
  assert.match(html, /data-i18n="flow_h"/);
  assert.match(html, /data-i18n="flow_step_source"/);
  assert.match(html, /data-i18n="flow_step_runtime"/);
  assert.match(html, /data-i18n="flow_step_sink"/);
  assert.match(html, /data-i18n="source_defs_h2"/);
  assert.match(html, /data-i18n="recorder_h2"/);
  assert.match(html, /data-i18n="dev_h2"/);
  assert.match(html, /class="compare-table"/);
  assert.match(html, /<a href="\/sources\.html" data-i18n="sources_cta"><\/a>/);
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
  assert.equal(i18n.es.why_h2, 'Por qué Habeas es diferente');
  assert.equal(i18n.es.hero_h1, 'Exporta tus propios datos.');
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
