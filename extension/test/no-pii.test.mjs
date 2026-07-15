import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../../scripts/scan-pii.mjs';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCOPE = ['extension/test', 'sources-repo/sources', 'extension/src/adapters'];
const EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html']);

function walk(dir, out = []) {
  let entries; try { entries = readdirSync(dir); } catch { return out; }
  for (const n of entries) {
    const p = join(dir, n); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (n !== 'node_modules' && n !== 'dist') walk(p, out); }
    else if (EXT.has(extname(n)) && n !== 'no-pii.test.mjs') out.push(p); // skip our own planted decoys
  }
  return out;
}

// Guardrail: no real captured data (account numbers, IBANs, live tokens) may enter fixtures or
// authored sources. Authored from a real API capture kept OUTSIDE the repo — fixtures must be
// wholly fictitious. A hit here means a real value slipped in; sanitise it (see scripts/scan-pii.mjs).
test('no real PII/secrets in fixtures, sources, or adapters', () => {
  const findings = [];
  for (const d of SCOPE) for (const f of walk(join(ROOT, d))) {
    for (const hit of scanText(readFileSync(f, 'utf8'), relative(ROOT, f))) findings.push(hit);
  }
  assert.equal(findings.length, 0,
    'Potential PII leak(s):\n' + findings.map((h) => `  ${h.file}:${h.line} [${h.rule}] ${h.sample} — ${h.why}`).join('\n'));
});

// The scanner itself must actually catch a planted leak (so it can't rot into a no-op).
test('scanner flags a planted account number, IBAN, and JWT', () => {
  assert.ok(scanText('const bban = "12345678901234567890";').some((h) => h.rule === 'long-digit-run'));
  assert.ok(scanText('iban: ES6621000418401111222233').some((h) => h.rule === 'iban' || h.rule === 'long-digit-run'));
  assert.ok(scanText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0').some((h) => h.rule === 'jwt'));
  // ...and does NOT flag the allowlisted fictitious values.
  assert.equal(scanText('codbban: "00000000991234500000"').length, 0);
});
