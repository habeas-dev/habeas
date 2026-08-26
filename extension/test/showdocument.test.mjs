import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sinkAcceptsArtifact } from '../src/sinks/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// A consumer reconciling bank movements wants the LIST of invoices and not the invoices. Cuentamo needs
// Amazon's records to match against and emphatically does not want five thousand PDFs — but when the user
// asks "what was this charge?", something has to show it. So: records are delivered, files are not, and
// the consumer may ask Habeas to DISPLAY one. The document never crosses; only an acknowledgement does.

test('a sink can accept records and refuse every file', () => {
  // An empty artifacts list is a statement, not an omission: "I accept these kinds, and there are none."
  const recordsOnly = { type: 'http', accepts: { artifacts: [] } };
  assert.equal(sinkAcceptsArtifact(recordsOnly, { kind: 'document', ext: 'pdf' }), false);
  assert.equal(sinkAcceptsArtifact(recordsOnly, { kind: 'data', ext: 'json' }), false);
  // Absent still means "anything", which is what every existing sink relies on.
  assert.equal(sinkAcceptsArtifact({ type: 'http' }, { kind: 'document', ext: 'pdf' }), true);
  // And a non-empty list keeps working as before.
  assert.equal(sinkAcceptsArtifact({ type: 'http', accepts: { artifacts: ['data'] } }, { kind: 'data', ext: 'json' }), true);
  assert.equal(sinkAcceptsArtifact({ type: 'http', accepts: { artifacts: ['data'] } }, { kind: 'document', ext: 'pdf' }), false);
});

test('show-document returns an acknowledgement and never the document', () => {
  const bg = read('src/background.js');
  const i = bg.indexOf('async function showDocumentForOrigin');
  assert.ok(i > 0, 'the API is not implemented');
  const body = bg.slice(i, bg.indexOf('\nasync function routesForOrigin', i));
  assert.match(body, /return \{ ok: true, status: 'shown' \}/, 'success is an acknowledgement');
  assert.ok(!/dataUrl|blob|base64|arrayBuffer/i.test(body), 'no representation of the file may be returned');
  assert.match(body, /chrome\.tabs\.create/, 'Habeas shows it in its own tab');
});

test('it may only show what was routed to that consumer', () => {
  const bg = read('src/background.js');
  const i = bg.indexOf('async function showDocumentForOrigin');
  const body = bg.slice(i, bg.indexOf('\nasync function routesForOrigin', i));
  assert.match(body, /const sinkId = sinkIdForOrigin\(origin\)/, 'origin-bound');
  assert.match(body, /deliveredSet\(ds\.id, sinkId\)/, 'checked against what that sink was delivered');
  assert.match(body, /if \(!delivered\[internalId\]\) return denied/, 'and refused otherwise');
});

test('every refusal is the same refusal, so it cannot be used to guess', () => {
  // The refusal is the one thing this can leak. If "not yours" read differently from "does not exist", a
  // consumer could walk ids and learn what somebody owns without ever receiving a byte.
  const bg = read('src/background.js');
  const i = bg.indexOf('async function showDocumentForOrigin');
  const body = bg.slice(i, bg.indexOf('\nasync function routesForOrigin', i));
  const returns = [...body.matchAll(/return (denied|\{[^}]*\})/g)].map((m) => m[1]);
  const failures = returns.filter((r) => r !== "{ ok: true, status: 'shown' }");
  assert.ok(failures.length >= 4, `expected several refusal paths, found ${failures.length}`);
  assert.deepEqual([...new Set(failures)], ['denied'], 'every refusal must be the identical object');
});

test('it renders from a readable destination, never from the consumer’s own', () => {
  // A consumer's sink is typically an HTTP endpoint and holds nothing retrievable; and reading back from
  // the caller's own destination would be asking the caller for the file it is not allowed to have.
  const bg = read('src/background.js');
  const i = bg.indexOf('async function showDocumentForOrigin');
  const body = bg.slice(i, bg.indexOf('\nasync function routesForOrigin', i));
  assert.match(body, /s\.id !== sinkId && isRetrievable\(s\)/);
});
