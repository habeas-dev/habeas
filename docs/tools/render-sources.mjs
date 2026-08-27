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
const S_START = '<!-- STATS:START -->', S_END = '<!-- STATS:END -->';
const F_START = '<!-- FILTERS:START -->', F_END = '<!-- FILTERS:END -->';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const flag = (code) => !code ? '' : code === 'global' ? '🌐'
  : (/^[A-Za-z]{2}$/.test(code) ? code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)) : '');

// Matches the page's card() markup. No live ratings in the static snapshot → "no ratings yet".
// Which sources have a guide page, written by build-source-pages.mjs — run that first.
const GUIDES = JSON.parse(readFileSync(join(here, '..', 'guides.json'), 'utf8'));

function card(s) {
  const fp = s.trust === 'first-party';
  const cats = (s.categories || []).map((c) => `<span class="cat">${esc(c)}</span>`).join('');
  const fmts = (s.formats || []).map((f) => `<span class="cat fmt">${esc(f)}</span>`).join('');
  return `<div class="src">
        <div class="top"><span class="name">${esc(s.name)}</span><span class="pill ${fp ? 'fp' : ''}">${fp ? 'first-party' : 'community'}</span>${s.beta ? '<span class="pill beta">experimental</span>' : ''}</div>
        <div class="meta">${s.country ? flag(s.country) + ' ' : ''}${esc(s.service)} · ${esc(s.domain)}</div>
        <div class="cats">${cats}${fmts}</div>
        <div class="foot"><span class="rate">no ratings yet</span><a class="view" href="${esc(s.url)}" rel="noopener" data-umami-event="source-view" data-umami-event-source="${esc(s.id)}">View JSON →</a></div>${GUIDES[s.id] ? `
        <a class="guide" href="/download/${GUIDES[s.id].en}.html">${s.beta ? 'What this draft covers →' : 'How to download →'}</a>` : ''}
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

// Figures, counted from the catalogue rather than typed. A hardcoded "24 services" is the number a
// model quotes back at people long after it stopped being true, which is worse than showing none.
const shipped = sources.filter((x) => !x.beta);
const stats = [
  [String(shipped.length), 'services covered', 'servicios cubiertos'],
  [String(shipped.filter((x) => x.trust === 'first-party').length), 'verified by the project', 'verificados por el proyecto'],
  [String(new Set(shipped.flatMap((x) => x.categories || [])).size), 'kinds of document', 'tipos de documento'],
  ['0', 'passwords stored', 'contraseñas almacenadas'],
];
const statsHtml = '\n      <div class="stats">' + stats.map(([n, en, es]) =>
  `<div class="stat"><b>${n}</b><span data-t-en="${esc(en)}" data-t-es="${esc(es)}">${esc(en)}</span></div>`).join('') + '</div>\n    ';

// Chips filter cards that are already in the document. Filtering hides, never removes: without JS, and
// to any crawler, the whole catalogue is present.
const cats = [...new Set(sources.flatMap((x) => x.categories || []))].sort();
const chips = ['<button class="chip" data-cat="" aria-pressed="true" data-t-en="All" data-t-es="Todo">All</button>']
  .concat(cats.map((c) => `<button class="chip" data-cat="${esc(c)}" aria-pressed="false">${esc(c)}</button>`));
const filtersHtml = '\n      <div class="filters" role="group">' + chips.join('') + '</div>\n    ';

// The catalogue as data. This page answers "which services does Habeas support"; without a list a machine
// reading it has to infer the answer from markup.
const itemList = {
  '@context': 'https://schema.org', '@type': 'ItemList',
  name: 'Habeas sources', numberOfItems: sources.length,
  itemListElement: sources.map((x, i) => ({
    '@type': 'ListItem', position: i + 1,
    item: { '@type': 'SoftwareApplication', name: x.name, applicationCategory: 'BrowserApplication',
            url: `https://habeas.dev/sources.html#${x.id}`, softwareVersion: x.version },
  })),
};
const ldHtml = `\n    <script type="application/ld+json">${JSON.stringify(itemList)}<\/script>\n  `;

let html = readFileSync(HTML, 'utf8');
const i = html.indexOf(START), j = html.indexOf(END);
if (i < 0 || j < 0) throw new Error('markers not found in sources.html');
html = html.slice(0, i + START.length) + cards + html.slice(j);
const fill = (str, a, b, body) => {
  const x = str.indexOf(a), y = str.indexOf(b);
  if (x < 0 || y < 0) throw new Error(`markers ${a} not found in sources.html`);
  return str.slice(0, x + a.length) + body + str.slice(y);
};
html = fill(html, S_START, S_END, statsHtml);
html = fill(html, F_START, F_END, filtersHtml);
html = html.replace(/\n    <script type="application\/ld\+json">[\s\S]*?<\/script>\n  /, '');
html = html.replace('</head>', `${ldHtml}</head>`);
html = html.replace(/(\n    const GUIDES = )[^\n]*/, `$1${JSON.stringify(GUIDES)};`);
writeFileSync(HTML, html);
console.log(`baked ${sources.length} sources into docs/sources.html`);
