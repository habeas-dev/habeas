#!/usr/bin/env node
// Refuse to publish a source whose version is not GREATER than the one already live, and print the next
// free version for anything you are about to edit.
//
//     node scripts/check-versions.mjs            # verify every local source against the live catalog
//     node scripts/check-versions.mjs next <id>  # print the next free version for <id>
//
// A version string identifies one exact content, permanently. If you change a source, you bump it; if the
// version is unchanged, there are no changes. The failure this guards against is publishing under a
// version that is not above the live one — the marketplace compares lexicographically
// (`lib/version.js#isOutdated` uses `a > b`), so the catalog updates but the update is never offered to
// anybody. Nothing errors and the fix simply does not ship.
//
// It bites on same-day re-publishes, because the `YYYY-MM-DD.N` suffix gets derived from the local file
// instead of from what is already published. Hence `next`: always take the suffix from the live catalog.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = join(HERE, '..', 'sources');
const INDEX_URL = process.env.HABEAS_INDEX || 'https://habeas-dev.github.io/sources/index.json';

const live = await fetch(INDEX_URL).then((r) => r.json()).catch((e) => {
  console.error(`could not read the live index (${e.message})`);
  process.exit(2);
});
const published = new Map((live.sources || live).map((s) => [s.id, String(s.version || '')]));

/** The next free version for today, always above whatever is live. */
function nextVersion(id, today) {
  const cur = published.get(id) || '';
  if (!cur.startsWith(today)) return today;             // nothing published today → the bare date
  const n = cur.length > today.length ? Number(cur.slice(today.length + 1)) || 0 : 0;
  return `${today}.${n + 1}`;                            // …and never the suffix already taken
}

if (process.argv[2] === 'next') {
  const id = process.argv[3];
  if (!id) { console.error('usage: check-versions.mjs next <source-id>'); process.exit(2); }
  const today = new Date().toISOString().slice(0, 10);
  console.log(nextVersion(id, today));
  process.exit(0);
}

const problems = [];
let checked = 0;

for (const file of readdirSync(SOURCES).filter((f) => f.endsWith('.json') && f !== 'index.json')) {
  const src = JSON.parse(readFileSync(join(SOURCES, file), 'utf8'));
  const local = String(src.version || '');
  const cur = published.get(src.id);
  if (cur === undefined) continue;        // brand new source — nothing to compare against
  checked++;
  if (local === cur) continue;            // same version means no changes, by definition
  if (!(local > cur)) {
    problems.push(`${src.id}: ${local} is not above the live ${cur} — the update would reach nobody`
      + ` (next free: ${nextVersion(src.id, local.slice(0, 10))})`);
  }
  // The newest changelog entry must name the version being published, or the marketplace shows notes
  // describing a different build.
  const top = (src.changelog || [])[0];
  if (top && String(top.version) !== local) {
    problems.push(`${src.id}: version ${local} but the newest changelog entry says ${top.version}`);
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✖ ${p}`);
  process.exit(1);
}
console.log(`${checked} sources compared against the live catalog — all publishable`);
