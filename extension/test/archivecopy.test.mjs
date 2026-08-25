import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The archive copy makes one promise: it moves documents you already have between destinations and
// never asks a service for anything. That promise is the whole reason it is safe to run without being
// logged in anywhere, and it is what the Settings copy reports back ("skipped: no file in any readable
// destination"). If the copy quietly fell back to the network, the report would be a lie and a bank
// session could be disturbed by a background sweep the user thought was a file move.
//
// These are structural assertions rather than behavioural ones on purpose: exercising the real path
// would mean standing up a service worker, the canonical store, a directory handle and four sink
// backends, and the resulting test would pin the mocks rather than the guarantee.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the copy asks the sender never to reach the source', () => {
  const bg = read('src/background.js');
  const fn = bg.slice(bg.indexOf('export async function runArchiveCopy'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /noSource:\s*true/, 'runArchiveCopy must pass noSource');
});

test('noSource short-circuits BEFORE any tab or session is looked for', () => {
  // noOpen alone was not enough: it only stops a NEW tab being opened, so an already-open one would
  // still be used and the copy would silently re-fetch from the site.
  const bg = read('src/background.js');
  const i = bg.indexOf('const ensureNet = async () =>');
  assert.ok(i > 0, 'ensureNet not found');
  const body = bg.slice(i, bg.indexOf('};', i));
  const guard = body.indexOf('opts.noSource');
  const call = body.indexOf('ensureSiteFetch');
  assert.ok(guard > -1, 'ensureNet must honour noSource');
  assert.ok(guard < call, 'the noSource guard must come before ensureSiteFetch, or it does nothing');
});

test('the page-side folder copy has no route to a source at all', () => {
  // The strongest guarantee available here: it cannot contact a service because it imports nothing
  // that can. If someone adds such an import, this fails and they have to justify it.
  const src = read('src/lib/foldercopy.js');
  for (const forbidden of ['pagefetch', 'ensureSiteFetch', 'listInventory', 'runRoute']) {
    assert.ok(!src.includes(forbidden), `foldercopy must not reach the source (found ${forbidden})`);
  }
});

test('a document with no file anywhere is skipped, not fetched', () => {
  const src = read('src/lib/foldercopy.js');
  assert.match(src, /if \(!arts\.length\) \{ skipped\+\+; continue; \}/,
    'the no-file case must skip and count, never fall through to a fetch');
});

test('the copy checkpoints, so an interrupted run resumes instead of restarting', () => {
  const src = read('src/lib/foldercopy.js');
  assert.match(src, /CHUNK = 25/, 'chunking is what bounds the loss from an interruption');
  assert.match(src, /markDelivered/, 'each flushed chunk must enter the ledger — the ledger IS the cursor');
});

test('Drive is a readable origin, and local-folder is not one for the service worker', () => {
  // Drive was excluded for no reason other than nobody having written the retrieval; local-folder is
  // genuinely impossible there, because a directory handle only exists in a page.
  const bg = read('src/background.js');
  const i = bg.indexOf('const SW_RETRIEVABLE');
  const line = bg.slice(i, bg.indexOf('\n', i));
  assert.match(line, /'drive'/, 'Drive must be usable as an origin in the background');
  assert.ok(!line.includes('local-folder'), 'the service worker cannot hold a directory handle');
  assert.match(read('src/lib/retrieve.js'), /RETRIEVABLE = new Set\(\[[^\]]*'drive'/, 'Drive must be retrievable');
});
