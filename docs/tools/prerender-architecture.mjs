#!/usr/bin/env node
// Bake ARCHITECTURE.md into docs/architecture.html, so the page carries its own text.
//
//     node docs/tools/prerender-architecture.mjs           # rewrite in place
//     node docs/tools/prerender-architecture.mjs --check    # exit 1 if stale (CI / pre-commit)
//
// The page used to fetch the markdown from raw.githubusercontent.com at page load and then POST it to
// GitHub's markdown API to be rendered. Two runtime dependencies on a third party for a page of our own
// prose: it went blank whenever either was slow, unreachable or rate-limiting, and to anything that does
// not execute JavaScript it read "Loading architecture…" and nothing else. That is why it has never had a
// heading — and why Search Console has never crawled it.
//
// The renderer covers what ARCHITECTURE.md actually uses (headings, paragraphs, lists, fenced code,
// blockquotes, inline code and emphasis) and nothing else. A markdown feature that appears later and is
// not handled will show up as literal text rather than being silently dropped.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MD = join(ROOT, 'ARCHITECTURE.md');
const PAGE = join(ROOT, 'docs', 'architecture.html');
const START = '<!-- prerendered:architecture -->';
const END = '<!-- /prerendered:architecture -->';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Headings get a stable slug so the page can be linked, and cited, by section. */
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

function render(md) {
  const out = [];
  const lines = md.split('\n');
  let i = 0, list = null;
  // ARCHITECTURE.md uses `#` for several top-level sections, which would emit several <h1> — the very
  // defect this page is being fixed for. The first one is the page title; everything after it drops a
  // level, so the hierarchy is preserved and the document has exactly one h1.
  let seenH1 = false;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {                       // fenced code, verbatim
      closeList();
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const text = h[2].trim();
      let level = h[1].length;
      if (level === 1 && !seenH1) seenH1 = true; else level = Math.min(level + 1, 6);
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      i++; continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      i++; continue;
    }
    if (line.startsWith('> ')) {
      closeList();
      const body = [];
      while (i < lines.length && lines[i].startsWith('> ')) { body.push(lines[i].slice(2)); i++; }
      out.push(`<blockquote><p>${inline(body.join(' '))}</p></blockquote>`);
      continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }

    closeList();                                        // paragraph: join until a blank line
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*]\s|\d+\.\s|```|> )/.test(lines[i])) {
      para.push(lines[i].trim()); i++;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  closeList();
  return out.join('\n');
}

const html = `${START}\n${render(readFileSync(MD, 'utf8'))}\n${END}`;
const page = readFileSync(PAGE, 'utf8');
const has = page.includes(START) && page.includes(END);
if (!has) {
  console.error(`${PAGE}: no ${START} … ${END} region to fill.`);
  process.exit(2);
}
const next = page.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => html);

if (process.argv.includes('--check')) {
  if (next !== page) { console.error('architecture.html is out of date — run prerender-architecture.mjs'); process.exit(1); }
  console.log('architecture.html is up to date'); process.exit(0);
}
writeFileSync(PAGE, next);
const headings = (html.match(/<h[1-4] /g) || []).length;
console.log(`architecture.html: baked ${headings} headings from ARCHITECTURE.md`);
