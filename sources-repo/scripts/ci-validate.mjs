// CI gate: every sources/*.json must be valid adapter DATA, pass the same-registrable-domain
// security guard, and conform to the JSON Schema. Exits non-zero on any failure.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { validateAdapter } from './validate.js';

const require = createRequire(import.meta.url);
let Ajv = require('ajv'); Ajv = Ajv.default || Ajv;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const schema = JSON.parse(readFileSync(join(root, 'schema/adapter.schema.json'), 'utf8'));
delete schema.$schema;
const ajv = new Ajv({ allErrors: true, strict: false });
const ajvValidate = ajv.compile(schema);

const dir = join(root, 'sources');
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
let failures = 0;

for (const f of files) {
  const errs = [];
  let adapter;
  try { adapter = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
  catch (e) { console.log(`FAIL  ${f} — invalid JSON: ${e.message}`); failures++; continue; }

  if (adapter.id + '.json' !== f) errs.push(`filename must be <id>.json (id=${adapter.id})`);
  const v = validateAdapter(adapter);       // structural + same-domain guard
  if (!v.ok) errs.push(...v.errors);
  if (!ajvValidate(adapter)) errs.push(...ajvValidate.errors.map((e) => `${e.instancePath} ${e.message}`));

  if (errs.length) { console.log(`FAIL  ${f}\n      ${errs.join('\n      ')}`); failures++; }
  else console.log(`PASS  ${f}  [${adapter.trust || 'community'}] ${adapter.domain}${(adapter.crossDomainHosts || []).length ? ' +offsite:' + adapter.crossDomainHosts.join(',') : ''}`);
}

console.log(`\n${files.length - failures}/${files.length} sources valid`);
process.exit(failures ? 1 : 0);
