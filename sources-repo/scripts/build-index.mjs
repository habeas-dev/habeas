// Build sources/index.json — the catalog the Habeas extension fetches. Run on push to main.
// Each entry points at the raw source JSON. SOURCES_BASE must match the extension's INDEX/base
// (extension/src/registry/client.js) and where Pages serves the files.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dir = join(root, 'sources');
const BASE = process.env.SOURCES_BASE || 'https://sources.habeas.dev';
const now = new Date().toISOString();

const entries = readdirSync(dir)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => {
    const a = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return {
      id: a.id, name: a.name, service: a.service,
      categories: a.categories || [], trust: a.trust || 'community',
      domain: a.domain, crossDomain: a.crossDomainHosts || [],
      version: (a.version || now.slice(0, 10)),
      url: `${BASE}/${f}`, updated: now,
    };
  })
  .sort((x, y) => x.id.localeCompare(y.id));

writeFileSync(join(dir, 'index.json'), JSON.stringify({ generated: now, sources: entries }, null, 2) + '\n');
console.log(`index.json: ${entries.length} sources (base ${BASE})`);
