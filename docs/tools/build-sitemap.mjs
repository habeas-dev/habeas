#!/usr/bin/env node
// Regenerate docs/sitemap.xml from the pages actually on disk, so a new page can never be left out
// of it by hand. Pages carrying <meta name="robots" content="noindex"> are skipped (OAuth callbacks
// and the like). <lastmod> comes from the file's last commit date, falling back to its mtime for
// files not yet committed.
//
//     node docs/tools/build-sitemap.mjs
//
// Re-run after adding or removing a page.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DOCS = join(here, '..');
const ORIGIN = 'https://habeas.dev';
const SKIP_DIRS = new Set(['tools', 'fonts', 'logos']);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(join(dir, e.name));
    return e.name.endsWith('.html') ? [join(dir, e.name)] : [];
  });
}

// What the previous sitemap said, so a run that cannot reach git history preserves the last known
// good dates instead of overwriting them with today's. Keyed by <loc>.
const PREVIOUS = (() => {
  const map = new Map();
  try {
    const xml = readFileSync(join(DOCS, 'sitemap.xml'), 'utf8');
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)) map.set(m[1], m[2]);
  } catch { /* first run */ }
  return map;
})();

// A shallow clone has no per-file history, so `git log -- <file>` is silently empty. That used to fall
// straight through to mtime, which in a fresh CI checkout is the checkout time: every page claimed to
// have changed today, every single day. Say so rather than quietly emitting a wrong date.
const SHALLOW = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: DOCS, encoding: 'utf8' }).trim() === 'true';
  } catch { return false; }
})();
if (SHALLOW) console.warn('warning: shallow clone — no per-file history, so <lastmod> is carried over from the previous sitemap');

function lastmod(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { cwd: DOCS, encoding: 'utf8' }).trim();
    if (out) return out;
  } catch { /* not a repo, or git unavailable — fall through */ }
  const previous = PREVIOUS.get(urlFor(file));
  if (previous) return previous;                       // keep what we last knew over a fabricated today
  return statSync(file).mtime.toISOString().slice(0, 10);
}

// index.html is served at the directory root; everything else keeps its filename.
const urlFor = (file) => {
  const rel = relative(DOCS, file).split('\\').join('/');
  return `${ORIGIN}/${rel.replace(/(^|\/)index\.html$/, '$1')}`;
};

const pages = walk(DOCS)
  .filter((f) => !/<meta\s+name="robots"[^>]*noindex/i.test(readFileSync(f, 'utf8')))
  .map((f) => ({ loc: urlFor(f), lastmod: lastmod(f) }))
  .sort((a, b) => a.loc.localeCompare(b.loc));

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...pages.map(({ loc, lastmod }) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`),
  '</urlset>',
  '',
].join('\n');

writeFileSync(join(DOCS, 'sitemap.xml'), xml);
console.log(`sitemap.xml: ${pages.length} pages`);
for (const p of pages) console.log(`  ${p.lastmod}  ${p.loc}`);
