// A route's delivery ledger is the cursor of what it already holds. runRoute used to list every source from
// scratch on every run and only THEN drop what the ledger knew — for WiZink that meant re-reading every closed
// statement (~1 s each, per card) on each sync. Handing the ledger to the lister as knownIds lets it stop at
// the first page/statement that brings nothing new; a forced run still re-lists everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('async function runRoute('), src.indexOf('async function runRoute(') + 12000);
const call = body.slice(body.indexOf('await listInventory('), body.indexOf('await listInventory(') + 600);

test('runRoute lists incrementally from its own delivery ledger', () => {
  assert.match(call, /knownIds:\s*opts\.force\s*\?\s*null\s*:\s*Object\.keys\(delivered\)/,
    'listInventory must receive the delivered ids (null on a forced run)');
});

// A document already delivered to ANOTHER destination (a statement in Dropbox, owed to a second sink) is read
// back from there — a closed statement never changes, so asking the bank for it again is pure cost. Measured
// 2026-09-29: an auto run re-downloaded two months of WiZink PDF + Excel that Dropbox already held.
test('runRoute reads a document back from another destination before fetching it from the source', () => {
  const loop = body.slice(body.indexOf('for (const k of kinds)'), body.indexOf('for (const k of kinds)') + 900);
  const kept = loop.indexOf('await retrieveArt(');
  const fetched = loop.indexOf('fetchArtifact(');
  assert.ok(kept > 0, 'runRoute must try retrieveArt');
  assert.ok(kept < fetched, 'retrieval comes before the source fetch');
  assert.match(body, /storeRetriever\(adapter, sink, opts\)/, 'built from the shared retriever (force → no retrieval)');
});
