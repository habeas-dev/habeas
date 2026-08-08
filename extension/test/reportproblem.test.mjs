import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src/ui/reportproblem.js');

// pickHandoff is imported directly; the rest of the module touches chrome.* and the DOM, so the
// remaining guards are asserted against the source. They are all about one thing: this feature must
// never send more than the user saw, and never destroy a recording they contributed.
const { pickHandoff } = await import(SRC);

test('a report joins the existing thread for that source instead of opening a new one', () => {
  const mine = [
    { id: 'h1', sourceId: 'carrefour-es' },
    { id: 'h2', sourceId: 'ing-es' },
  ];
  // POST /handoff supersedes any prior submission for the same source: picking wrong here throws away
  // whatever recording the user contributed.
  assert.equal(pickHandoff(mine, 'ing-es').id, 'h2');
  assert.equal(pickHandoff(mine, 'carrefour-es').id, 'h1');
  assert.equal(pickHandoff(mine, 'wizink-es'), null, 'a source with no thread must open a new report');
});

test('pickHandoff tolerates every shape the service and an offline client can produce', () => {
  assert.equal(pickHandoff(null, 'ing-es'), null);
  assert.equal(pickHandoff(undefined, 'ing-es'), null);
  assert.equal(pickHandoff([], 'ing-es'), null);
  assert.equal(pickHandoff({ handoffs: [{ id: 'h9', source: 'ing-es' }] }, 'ing-es').id, 'h9',
    'the service may key it `source` and wrap it in an object');
});

test('nothing is sent that the user has not been shown, and the trace survives a failed send', async () => {
  const src = await fs.readFile(SRC, 'utf8');

  // The preview and the payload must come from the same builder — two builders drift, and the drift
  // would be text the user never saw leaving their machine.
  const builds = (src.match(/buildReport\(/g) || []).length;
  assert.ok(builds >= 3, 'preview and send must both go through buildReport');
  assert.match(src, /const \{ text \} = await buildReport\(sourceId, note\.value\)/,
    'the sent text must be rebuilt from the same note the preview rendered');

  // Redaction is not optional.
  assert.match(src, /scrubText\(formatDiag\(diag\) \+ formatReqCtx\(/, 'the trace must be scrubbed before it is used at all');

  // Clearing before the service accepted it would lose the only copy of the failure.
  const clearAt = src.indexOf('clearDiag(sourceId)');
  const sendAt = src.indexOf('await send(sourceId, text)');
  assert.ok(sendAt > -1 && clearAt > sendAt, 'the diagnostic must only be cleared after a successful send');
});
