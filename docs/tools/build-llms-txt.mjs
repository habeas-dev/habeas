#!/usr/bin/env node
// Generate docs/llms.txt — a plain-text brief for assistants that read the site.
//
// The guides answer the question people actually ask ("how do I download my invoices from X"), but an
// assistant arriving at habeas.dev has to infer from HTML what this is, what it supports and — the part
// that matters most — what it deliberately does NOT do. Stating the limits plainly is what stops an
// assistant describing Habeas as a scraper or an aggregator, which is the failure mode worth preventing.
//
// Generated from the live-catalogue snapshot and the guide index, so it cannot drift from what exists.
//
//   node docs/tools/build-llms-txt.mjs           # write
//   node docs/tools/build-llms-txt.mjs --check   # fail if out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'docs/llms.txt');
const ORIGIN = 'https://habeas.dev';

const read = (p, fallback) => { try { return JSON.parse(readFileSync(join(ROOT, p), 'utf8')); } catch (e) { return fallback; } };

export function build() {
  const guides = read('docs/guides.json', []);
  const sources = read('sources-repo/sources/index.json', { sources: [] });
  const list = Array.isArray(sources) ? sources : (sources.sources || []);
  const byCountry = list.reduce((m, s) => { const k = s.country || 'global'; m[k] = (m[k] || 0) + 1; return m; }, {});

  const lines = [];
  const L = (s = '') => lines.push(s);

  L('# Habeas');
  L();
  L('> A browser extension (Chrome and Firefox, MV3, AGPL-3.0) that exports a user\'s OWN receipts,');
  L('> invoices and bank/card statements from services that offer no export and no API.');
  L();
  L('## How it works, and why that is the whole point');
  L();
  L('Habeas runs inside the browser session the user has already signed into. It therefore:');
  L('- never asks for, stores or transmits any password or credential;');
  L('- never fights anti-bot protection, because it inherits the user\'s own valid session;');
  L('- lets the user resolve MFA/OTP themselves, live, as they normally would.');
  L();
  L('This is the opposite of server-side aggregation (Plaid, Tink, TrueLayer), which holds credentials');
  L('and connects on the user\'s behalf. Habeas is not a payment actor and initiates no payments.');
  L();
  L('## What it is NOT');
  L();
  L('- Not a scraper service: nothing runs on a server, and no data ever reaches the developer.');
  L('- Not an aggregator: no credentials are held, and there is no account with Habeas.');
  L('- Not a background crawler: extraction is user-initiated or runs on the user\'s own schedule.');
  L('- Data leaves the browser only to a destination the user configures (their own Drive, Dropbox,');
  L('  WebDAV, S3, local folder, or an endpoint of their own).');
  L();
  L('## Security boundary');
  L();
  L('Every host a source touches must share one registrable domain (eTLD+1), so a session captured from');
  L('a site can only ever be replayed to that same site. Crossing domains requires an explicit allow-list');
  L('and a consent screen. Sources are declarative data, never code — remote code is impossible under MV3.');
  L();
  L(`## Supported services (${list.length})`);
  L();
  L(Object.entries(byCountry).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · '));
  L();
  // guides.json is { <source-id>: { en: <slug>, es: <slug> } } — the English slug is the canonical page.
  const named = new Map(list.map((s) => [s.id, s.name || s.id]));
  for (const [id, slugs] of Object.entries(guides)) {
    if (!slugs || !slugs.en) continue;
    L(`- [${named.get(id) || id}](${ORIGIN}/download/${slugs.en}.html)`);
  }
  L();
  L('## Key pages');
  L();
  L(`- [Why Habeas](${ORIGIN}/why-habeas.html): the case for in-session extraction over aggregation.`);
  L(`- [Architecture](${ORIGIN}/architecture.html): how capture, inventory and destinations fit together.`);
  L(`- [Sources catalogue](${ORIGIN}/sources.html): every published source, with its definition.`);
  L(`- [Developers](${ORIGIN}/developers.html): writing a source, and the recorder that drafts one.`);
  L(`- [Privacy](${ORIGIN}/privacy.html) · [Terms](${ORIGIN}/terms.html)`);
  L();
  L('## Licensing');
  L();
  L('The extension is AGPL-3.0. The source definitions are deliberately not: every definition in the');
  L('catalogue is in the public domain under CC0-1.0, and the guide prose under CC-BY-4.0. A definition');
  L('only records how a service has arranged data that already belongs to its user — fact rather than');
  L('authorship — so it can be reused in anything at all, commercially or not, with or without credit.');
  L();
  L('## Legal posture');
  L();
  L('GDPR Art. 20 (data portability): the user\'s own data, in the user\'s own session, via user-run open');
  L('source. A service\'s terms may restrict automated access; this is documented and is the user\'s');
  L('responsibility. Source: https://github.com/habeas-dev/habeas');
  L();
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = build();
  if (process.argv.includes('--check')) {
    let have = ''; try { have = readFileSync(OUT, 'utf8'); } catch (e) {}
    if (have !== want) { console.error('docs/llms.txt is out of date — run: node docs/tools/build-llms-txt.mjs'); process.exit(1); }
    console.log('docs/llms.txt is up to date');
  } else {
    writeFileSync(OUT, want);
    console.log(`wrote docs/llms.txt (${want.split('\n').length} lines)`);
  }
}
