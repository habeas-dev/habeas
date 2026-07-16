#!/usr/bin/env node
// PII / secret guard. Stops real captured data (account numbers, IBANs, live tokens) and raw
// capture dumps from ever reaching a commit. Sources authored from a real API capture must use
// wholly fictitious values in fixtures — this catches the human slip of pasting a real one.
//
// Two entry points:
//   node scripts/scan-pii.mjs            → scan the tracked in-repo scope (used by `npm test`)
//   node scripts/scan-pii.mjs --staged   → scan git-staged content only (used by the pre-commit hook)
//
// A finding fails the run (exit 1). If a match is a KNOWN-FICTITIOUS test value, add it to
// ALLOWLIST below *and say so in the commit* — that human step is the point: no long digit run
// enters the repo without someone eyeballing it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// Directories where a real capture is most likely to leak (fixtures, authored sources, adapters).
const SCOPE_DIRS = ['extension/test', 'sources-repo/sources', 'extension/src/adapters'];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.ts', '.md', '.html']);
// Self-tests that deliberately plant fake, PII-SHAPED values to prove a detector/redactor fires —
// skip them (their content is synthetic by construction and asserted to be stripped).
const SELF_TESTS = new Set(['no-pii.test.mjs', 'redact.test.mjs']);
const isSelfTest = (name) => [...SELF_TESTS].some((s) => name === s || name.endsWith('/' + s));

// Confirmed-fictitious long digit runs already in the tree (example IBAN tail, IKEA test id,
// test card, sanitised BBAN, all-repeated placeholders). Grow this ONLY with values you have
// verified are invented — never to silence a real leak.
const ALLOWLIST = new Set([
  '00000000000000000000',
  '000000000000000000000000',
  '00000000991234500000',      // openbank.test.mjs — fictitious BBAN
  '1111111111111111111111',
  '2222222222222222222222',
  '4111111111111111',          // canonical test Visa
  '9121000418450200051332',    // ES9121000418450200051332 — canonical ES example IBAN
  '9900000000000000000001',    // ikea-graphql-pdf.test.mjs — fake receipt id
]);

// Path fragments that mean "this is a raw capture" and must never be committed anywhere.
const CAPTURE_PATH = /(^|\/)(.*-)?capture[^/]*\.(jsonl?|har|txt)$|mitm|\.har$|obk-|har-capture/i;

const RULES = [
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/g,
    why: 'looks like a live JWT (eyJ…header.payload) — session tokens must never be committed' },
  { id: 'iban', re: /\b[A-Z]{2}\d{2}[ ]?(?:\d[ ]?){14,30}\b/g,
    why: 'looks like an IBAN', filter: (m) => digits(m).length >= 16 && !ALLOWLIST.has(digits(m)) },
  { id: 'long-digit-run', re: /\d{15,}/g,
    why: 'a 15+ digit run (account/card/BBAN?) — if invented, add it to scan-pii.mjs ALLOWLIST',
    filter: (m) => !ALLOWLIST.has(m) },
];

function digits(s) { return s.replace(/\D/g, ''); }

export function scanText(text, file = '') {
  const found = [];
  const lines = text.split('\n');
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const m of line.matchAll(rule.re)) {
        const val = m[0];
        if (rule.filter && !rule.filter(val)) continue;
        found.push({ file, line: i + 1, rule: rule.id, why: rule.why, sample: redact(val) });
      }
    }
  }
  return found;
}

// Never echo the offending value in full — a CI log is one more place it must not live.
function redact(v) {
  const d = v.length;
  return d <= 8 ? '•'.repeat(d) : v.slice(0, 3) + '…' + '•'.repeat(Math.min(6, d - 6)) + '…' + v.slice(-2);
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(p, out); }
    else if (SCAN_EXT.has(extname(name)) && !isSelfTest(name)) out.push(p);
  }
  return out;
}

function scanTree() {
  const findings = [];
  for (const d of SCOPE_DIRS) for (const f of walk(join(ROOT, d))) {
    for (const hit of scanText(readFileSync(f, 'utf8'), relative(ROOT, f))) findings.push(hit);
  }
  return findings;
}

function scanStaged() {
  const findings = [];
  const out = execSync('git diff --cached --name-only --diff-filter=ACM', { cwd: ROOT }).toString();
  const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const f of files) {
    if (CAPTURE_PATH.test(f)) {
      findings.push({ file: f, line: 0, rule: 'capture-file', why: 'raw capture dump must never be committed', sample: '' });
      continue;
    }
    if (!SCAN_EXT.has(extname(f)) || isSelfTest(f)) continue;
    let blob = '';
    try { blob = execSync(`git show :"${f}"`, { cwd: ROOT }).toString(); } catch { continue; }
    for (const hit of scanText(blob, f)) findings.push(hit);
  }
  return findings;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const staged = process.argv.includes('--staged');
  const findings = staged ? scanStaged() : scanTree();
  if (findings.length) {
    console.error(`\n✖ PII/secret guard: ${findings.length} potential leak(s) — commit blocked.\n`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.sample}\n     ${f.why}`);
    console.error('\nIf a match is a KNOWN-FICTITIOUS test value, add it to ALLOWLIST in scripts/scan-pii.mjs.\n');
    process.exit(1);
  }
  console.log(`✓ PII/secret guard: clean (${staged ? 'staged' : 'tree'}).`);
}
