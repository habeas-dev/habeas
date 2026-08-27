#!/usr/bin/env node
// Give the interior pages the structure the home page has: a header band (or a plain rule for the legal
// pages), stable ids on every h2, and a table of contents built FROM those h2s.
//
//     node docs/tools/build-page-layout.mjs           # rewrite the pages in place
//     node docs/tools/build-page-layout.mjs --check   # exit 1 if any page is stale
//
// The table of contents is generated rather than written, because a hand-kept one goes out of date the
// first time somebody edits a heading, and a table of contents that lies is worse than none. Running this
// again after editing a page refreshes it.
//
// Two rules this encodes, both easy to get wrong:
//   · the h1 moved into the band IS the page's h1 — it is relocated, never duplicated, so the page keeps
//     exactly one and the band is not decoration wrapped around a hidden heading.
//   · existing h2 text is never rewritten, only given an id. Those headings are what is indexed today;
//     the ids add anchors so a search engine can surface a passage, without touching the wording.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// mode 'band'  → green header, for the pages that are making a case.
// mode 'head'  → a rule and a title. A privacy policy under a campaign banner reads as marketing.
const PAGES = [
  { file: 'docs/why-habeas.html',        mode: 'band', kicker: 'Why Habeas',        toc: 'On this page' },
  { file: 'docs/es/por-que-habeas.html', mode: 'band', kicker: 'Por qué Habeas',    toc: 'En esta página' },
  { file: 'docs/developers.html',        mode: 'band', kicker: 'Developers',        toc: 'On this page' },
  { file: 'docs/es/desarrolladores.html',mode: 'band', kicker: 'Developers',        toc: 'En esta página' },
  { file: 'docs/privacy.html',           mode: 'head', toc: 'On this page' },
  { file: 'docs/terms.html',             mode: 'head', toc: 'On this page' },
  { file: 'docs/es/privacidad.html',     mode: 'head', toc: 'En esta página' },
  { file: 'docs/es/terminos.html',       mode: 'head', toc: 'En esta página' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (html) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const slug = (s) => text(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const TOC_START = '<!-- toc:start -->';
const TOC_END = '<!-- toc:end -->';

/** Read the h2s, giving any that lack one a stable id, and return the contents list to match. */
function indexHeadings(body) {
  const items = [];
  const next = body.replace(/<h2([^>]*)>([\s\S]*?)<\/h2>/g, (m, attrs, inner) => {
    const existing = /id="([^"]+)"/.exec(attrs);
    const id = existing ? existing[1] : slug(inner);
    items.push({ id, label: text(inner) });
    return `<h2${existing ? attrs : `${attrs} id="${id}"`}>${inner}</h2>`;
  });
  return { body: next, items };
}

const tocHtml = (items, label) => `${TOC_START}
      <nav class="toc" aria-label="${esc(label)}">
${items.map((it) => `        <a href="#${it.id}">${esc(it.label)}</a>`).join('\n')}
      </nav>
      ${TOC_END}`;

// Two jobs, deliberately separated. Moving the heading into a header happens ONCE, when a page has no
// header yet. Keeping the contents list in step with the headings happens on every run — that is the part
// that rots. An earlier version undid and redid the whole transform each time, which grew the file by a
// line per run and could never agree with itself.
function transform(html, page) {
  const main = /<main([^>]*)>([\s\S]*?)<\/main>/.exec(html);
  if (!main) throw new Error(`${page.file}: no <main>`);

  // The highlight script is loaded only where there is a contents list to highlight.
  const withScript = (h) => (h.includes('/toc.js') || !h.includes(TOC_START)) ? h
    : h.replace('</body>', '  <script defer src="/toc.js"></script>\n</body>');

  if (html.includes(TOC_START)) {                       // already laid out: refresh only
    const { body, items } = indexHeadings(main[2]);
    const refreshed = body.replace(new RegExp(`${TOC_START}[\\s\\S]*?${TOC_END}`), () => tocHtml(items, page.toc));
    return withScript(html.slice(0, main.index) + `<main${main[1]}>` + refreshed + '</main>' + html.slice(main.index + main[0].length));
  }

  let body = main[2];
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>\s*/.exec(body);
  if (!h1) throw new Error(`${page.file}: no <h1> to lift`);
  body = body.replace(h1[0], '');
  const lead = /^\s*<p class="lead">([\s\S]*?)<\/p>\s*/.exec(body);
  if (lead) body = body.replace(lead[0], '');
  body = '\n' + body.replace(/^\s+/, '');

  const inner = `${page.mode === 'band' ? `      <p class="kicker">${esc(page.kicker)}</p>\n` : ''}      <h1>${h1[1].trim()}</h1>
${lead ? `      <p class="lead">${lead[1].trim()}</p>\n` : ''}`;
  const header = `  <section class="${page.mode === 'band' ? 'band' : 'page-head'}">\n    <div class="wrap">\n${inner}    </div>\n  </section>\n\n`;

  const idx = indexHeadings(body);
  const laid = idx.items.length >= 3
    ? `\n    <div class="docgrid">\n      ${tocHtml(idx.items, page.toc)}\n      <div class="doccol">${idx.body}</div>\n    </div>\n  `
    : idx.body;

  // A page with a contents list needs room for two columns. Each page's own <style> pins .doc to 780px
  // and loads after style.css, so the wider rule has to out-specify it — hence a second class rather
  // than a media query or an !important.
  const attrs = idx.items.length >= 3 && !/class="[^"]*has-toc/.test(main[1])
    ? main[1].replace(/class="([^"]*)"/, 'class="$1 has-toc"') : main[1];
  return withScript(html.slice(0, main.index).replace(/[ \t]*$/, '') + header
       + `  <main${attrs}>` + laid + `</main>` + html.slice(main.index + main[0].length));
}

let stale = 0;
for (const page of PAGES) {
  const path = join(ROOT, page.file);
  const before = readFileSync(path, 'utf8');
  const after = transform(before, page);
  if (after === before) continue;
  stale++;
  if (!process.argv.includes('--check')) writeFileSync(path, after);
  console.log(`${process.argv.includes('--check') ? 'stale' : 'laid out'}: ${page.file}`);
}
if (process.argv.includes('--check') && stale) {
  console.error(`${stale} page(s) out of date — run build-page-layout.mjs`);
  process.exit(1);
}
console.log(process.argv.includes('--check') ? 'all pages up to date' : `${PAGES.length} pages processed`);
