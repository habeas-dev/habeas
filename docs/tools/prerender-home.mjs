#!/usr/bin/env node
// Bake the English copy from i18n.js into docs/index.html, so the page carries real text in its HTML
// instead of 100+ empty [data-i18n] shells that only fill in once JavaScript runs. i18n.js still owns
// the copy and still swaps to Spanish on demand — this only pre-renders the default (English) state.
//
//     node docs/tools/prerender-home.mjs           # rewrite index.html in place
//     node docs/tools/prerender-home.mjs --check   # exit 1 if it is out of date (for CI / pre-commit)
//
// Re-run after editing any English string in i18n.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const I18N_JS = join(here, '..', 'i18n.js');
const HTML = join(here, '..', 'index.html');

// i18n.js is a classic script (no exports — the page loads it with a plain <script src>), so read the
// I18N literal out of the source rather than importing it.
function loadDict() {
  const src = readFileSync(I18N_JS, 'utf8');
  const start = src.indexOf('const I18N = {');
  if (start === -1) throw new Error('could not find `const I18N = {` in i18n.js');
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) throw new Error('unbalanced braces in the I18N literal');
  const dict = new Function(`return ${src.slice(open, end)}`)();
  if (!dict.en) throw new Error('I18N has no `en` dictionary');
  return dict.en;
}

const escText = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function prerender(html, en) {
  const missing = [];
  // Every [data-i18n] element is a leaf (apply() sets textContent, which would wipe children anyway),
  // so matching to the first matching close tag is safe.
  let out = html.replace(/<(\w+)((?:[^>]*?)\bdata-i18n="([^"]+)"(?:[^>]*?))>(.*?)<\/\1>/gs,
    (whole, tag, attrs, key) => {
      const v = en[key];
      if (v == null) { missing.push(key); return whole; }
      return `<${tag}${attrs}>${escText(v)}</${tag}>`;
    });
  // Keep the head in lockstep with the dictionary so the served metadata can never drift from apply().
  out = out
    .replace(/(<title>)(.*?)(<\/title>)/s, `$1${escText(en.title)}$3`)
    .replace(/(<meta name="description" content=")(.*?)(")/s, `$1${escAttr(en.desc)}$3`)
    .replace(/(<meta property="og:title" content=")(.*?)(")/s, `$1${escAttr(en.title)}$3`)
    .replace(/(<meta property="og:description" content=")(.*?)(")/s, `$1${escAttr(en.desc)}$3`);
  return { out, missing };
}

const en = loadDict();
const html = readFileSync(HTML, 'utf8');
const { out, missing } = prerender(html, en);

if (missing.length) {
  console.error(`missing English strings for: ${[...new Set(missing)].join(', ')}`);
  process.exit(1);
}

const filled = (out.match(/data-i18n="/g) || []).length;
if (process.argv.includes('--check')) {
  if (out !== html) {
    console.error('index.html is out of date — run: node docs/tools/prerender-home.mjs');
    process.exit(1);
  }
  console.log(`index.html is up to date (${filled} strings)`);
} else {
  if (out !== html) writeFileSync(HTML, out);
  console.log(`pre-rendered ${filled} English strings into docs/index.html${out === html ? ' (no change)' : ''}`);
}
