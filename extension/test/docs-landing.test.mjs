import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(__dirname, '../../docs');
const sectionMarkers = [
  'problem_h2',
  'how_h2',
  'why_h2',
  'dest_h2',
  'id="install"',
  'oss_h2',
];

async function loadLanding() {
  const [html, script] = await Promise.all([
    fs.readFile(path.join(docsDir, 'index.html'), 'utf8'),
    fs.readFile(path.join(docsDir, 'i18n.js'), 'utf8'),
  ]);

  const context = {
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { language: 'en' },
    document: {
      _listeners: {},
      addEventListener(type, listener) {
        this._listeners[type] = listener;
      },
    },
    globalThis: {},
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(`${script}\nglobalThis.__I18N = I18N;`, context);
  return { html, i18n: context.__I18N };
}

test('landing page keeps the new information hierarchy', async () => {
  const { html } = await loadLanding();
  const positions = sectionMarkers.map((marker) => html.indexOf(marker));

  sectionMarkers.forEach((marker, index) => {
    const position = positions[index];
    assert.notEqual(position, -1, `missing section marker '${marker}'`);
  });
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] < positions[i], 'sections should appear in the expected order');
  }

  assert.match(html, /data-i18n="hero_note"/);
  assert.match(html, /class="feature-strip"/);
  assert.match(html, /data-i18n="flow_h"/);
  assert.match(html, /class="compare-table"/);
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
  assert.equal(i18n.es.why_h2, 'Por qué Habeas es diferente');
});
