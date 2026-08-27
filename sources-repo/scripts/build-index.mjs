// Build sources/index.json — the catalog the Habeas extension fetches. Run on push to main.
// Each entry points at the raw source JSON. SOURCES_BASE must match the extension's INDEX/base
// (extension/src/registry/client.js) and where Pages serves the files.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { behaviourHash } from './behaviour-hash.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dir = join(root, 'sources');
const BASE = process.env.SOURCES_BASE || 'https://habeas-dev.github.io/sources';
const now = new Date().toISOString();

// `updated` is when the SOURCE last changed, read from git — not when the index was built. Stamping the
// build time made all 24 entries move on every run, so the field could not answer the only question it is
// asked ("what changed since I last looked") and the index diff buried the one real change in noise.
//
// This needs full history. `actions/checkout` clones with depth 1 by default, and on a shallow clone
// `git log` only knows the tip commit — every file the tip did not touch would silently fall back to the
// build time, which is the bug we are fixing wearing a different hat. So the shallowness is checked once
// and shouted about rather than absorbed.
const git = (args) => {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};
const HAS_GIT = git(['rev-parse', '--git-dir']) !== '';
if (HAS_GIT && git(['rev-parse', '--is-shallow-repository']) === 'true') {
  console.warn('WARNING: shallow clone — `updated` will fall back to the build time for every source the '
    + 'tip commit did not touch. Check out with fetch-depth: 0.');
}
// One pass over the history rather than a git call per file: `--name-only` prints each commit's date
// followed by the paths it touched, so the first date a path appears under is its last change.
const lastChange = (() => {
  const map = new Map();
  if (!HAS_GIT) return map;
  let date = null;
  for (const line of git(['log', '--format=%cI', '--name-only', '--', 'sources']).split('\n')) {
    if (line === '') continue;
    if (line.includes('T') && !line.includes('/')) { date = line; continue; }
    const f = line.slice(line.lastIndexOf('/') + 1);
    if (!map.has(f)) map.set(f, date);
  }
  return map;
})();

// The file formats a source produces (json | pdf | xls | html …), mirroring the runtime's artifactKinds.
function formatsOf(a) {
  const api = a.api || {}, out = new Set();
  if (api.detail && !api.detail.as) out.add('json');
  const dc = api.document || (api.detail && api.detail.as ? api.detail : null);
  if (dc) out.add(dc.as === 'render' || dc.as === 'html' || dc.as === 'invoice' ? 'html' : 'pdf');
  else if (api.pdf) out.add(api.pdf.ext || 'pdf');
  return [...out];
}

const entries = readdirSync(dir)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => {
    const a = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return {
      id: a.id, name: a.name, service: a.service,
      categories: a.categories || [], trust: a.trust || 'community',
      beta: !!a.beta,   // experimental: drafted but not yet verified against a real in-session capture
      domain: a.domain, country: a.country || null, formats: formatsOf(a), crossDomain: a.crossDomainHosts || [],
      version: (a.version || now.slice(0, 10)),
      minVersion: a.minVersion || null,
      gaps: a.gaps || [],   // products this source doesn't cover yet — a user who has one can "Complete" it
      contributors: a.contributors || [], // handles credited for the recording this source was built from
      changelog: a.changelog || [],
      // A source added but not yet committed (a PR being validated) has no git date; the build time is
      // the honest answer there, not a missing field.
      url: `${BASE}/${f}`, updated: lastChange.get(f) || now,
      behaviourHash: behaviourHash(a),
    };
  })
  .sort((x, y) => x.id.localeCompare(y.id));

writeFileSync(join(dir, 'index.json'), JSON.stringify({ generated: now, sources: entries }, null, 2) + '\n');
console.log(`index.json: ${entries.length} sources (base ${BASE})`);
