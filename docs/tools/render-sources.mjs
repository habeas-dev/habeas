#!/usr/bin/env node
// Pre-render the sources catalog into docs/sources.html between the SOURCES:START/END markers, so the page
// shows the list WITHOUT JavaScript (progressive enhancement — the page's own script hydrates it with live
// data, ratings and filters on load). Re-run after publishing a source to the registry:
//     node docs/tools/render-sources.mjs            # fetch the live index
//     node docs/tools/render-sources.mjs <file>     # or read a local index.json
// The static snapshot is a FALLBACK; JS clients always see live data, so mild staleness here is fine.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const INDEX_URL = 'https://habeas-dev.github.io/sources/index.json';
const here = dirname(fileURLToPath(import.meta.url));
const HTML = join(here, '..', 'sources.html');
const START = '<!-- SOURCES:START -->', END = '<!-- SOURCES:END -->';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const flag = (code) => !code ? '' : code === 'global' ? '🌐'
  : (/^[A-Za-z]{2}$/.test(code) ? code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)) : '');

// Matches the page's card() markup. No live ratings in the static snapshot → "no ratings yet".
function card(s) {
  const fp = s.trust === 'first-party';
  const cats = (s.categories || []).map((c) => `<span class="cat">${esc(c)}</span>`).join('');
  const fmts = (s.formats || []).map((f) => `<span class="cat fmt">${esc(f)}</span>`).join('');
  return `<div class="src">
        <div class="top"><span class="name">${esc(s.name)}</span><span class="pill ${fp ? 'fp' : ''}">${fp ? 'first-party' : 'community'}</span></div>
        <div class="meta">${s.country ? flag(s.country) + ' ' : ''}${esc(s.service)} · ${esc(s.domain)}</div>
        <div class="cats">${cats}${fmts}</div>
        <div class="foot"><span class="rate">no ratings yet</span><a class="view" href="${esc(s.url)}" rel="noopener">View JSON →</a></div>
      </div>`;
}

async function loadIndex() {
  const arg = process.argv[2];
  if (arg) return JSON.parse(readFileSync(arg, 'utf8'));
  const r = await fetch(INDEX_URL);
  if (!r.ok) throw new Error('fetch index ' + r.status);
  return r.json();
}

const data = await loadIndex();
const sources = (data.sources || data || []).slice()
  .sort((a, b) => (a.trust === b.trust ? String(a.name).localeCompare(b.name) : a.trust === 'first-party' ? -1 : 1));
const cards = '\n      ' + sources.map(card).join('\n      ') + '\n      ';

let html = readFileSync(HTML, 'utf8');
const i = html.indexOf(START), j = html.indexOf(END);
if (i < 0 || j < 0) throw new Error('markers not found in sources.html');
html = html.slice(0, i + START.length) + cards + html.slice(j);
writeFileSync(HTML, html);
console.log(`baked ${sources.length} sources into docs/sources.html`);
