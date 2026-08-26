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

// ---------------------------------------------------------------- origin ≠ destination

test('the destination is never used as one of the origins', () => {
  // Reading a file from the very place being written to is at best a no-op and at worst a rewrite of
  // the thing the copy exists to preserve. Enforced in BOTH senders, because they read different sinks.
  const bg = read('src/background.js');
  const i = bg.indexOf('const stores = ');
  assert.ok(i > 0, 'the origin list was not found');
  assert.match(bg.slice(i, bg.indexOf('\n', i)), /s\.id !== sink\.id/, 'the background must exclude the target');

  const ui = read('src/ui/options.js');
  assert.match(ui, /type === 'local-folder' && s\.id !== target\.id/, 'the page pass must exclude the target too');
});

test('the user is told what the copy will read from, not only where it writes', () => {
  // The origins are not chosen — each file comes from whichever destination happens to hold it — so
  // without this the user approves an operation without being told what it touches.
  const ui = read('src/ui/options.js');
  assert.match(ui, /describeCopy/, 'no origin/destination description');
  assert.match(ui, /opt_copy_from/, 'the description must name both ends');
  assert.match(ui, /copySel\.onchange = describeCopy/, 'it must follow the chosen destination');
  for (const lang of ['en', 'es']) {
    const msg = JSON.parse(read(`_locales/${lang}/messages.json`));
    assert.ok(msg.opt_copy_from && msg.opt_copy_noorigin, `${lang} is missing the copy description strings`);
  }
});

test('a destination with no possible origin cannot be started', () => {
  // Picking your only readable destination as the target used to report "already holds everything",
  // which is false: there was simply nowhere to read from.
  const ui = read('src/ui/options.js');
  const i = ui.indexOf('const describeCopy');
  const body = ui.slice(i, ui.indexOf('copySel.onchange', i));
  assert.match(body, /origins\.length > 0/, 'an empty origin list must block the copy');
  assert.match(body, /\$\('#copystart'\)\.disabled = !ok/, 'the button must reflect it');
  assert.match(body, /opt_copy_noorigin/, 'and the reason must be shown');
});

test('the readable set is imported, not restated, so the UI cannot drift from what can be read', () => {
  const ui = read('src/ui/options.js');
  assert.match(ui, /import \{ RETRIEVABLE \} from '\.\.\/lib\/retrieve\.js'/,
    'listing the readable types by hand in the UI is how it starts lying');
});

test('a running copy can be stopped, and stopping actually reaches the loop', () => {
  const ui = read('src/ui/options.js');
  assert.match(ui, /#copystop/, 'no stop control');
  assert.match(ui, /new AbortController\(\)/, 'the page pass needs its own signal');
  assert.match(ui, /type: 'habeas:stop'/, 'and the background pass needs to be told');
  const bg = read('src/background.js');
  assert.match(bg, /function stopOp\(\)[^\n]*__opAbort\.abort/, 'habeas:stop must abort the op signal');
  const fn = bg.slice(bg.indexOf('export async function runArchiveCopy'));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /signal\.aborted/, 'the copy loop must check the signal');
});

test('the copy does not open on the destination the archive itself lives in', () => {
  // Reported from real use: with the archive in Dropbox, the picker defaulted to Dropbox and offered
  // "will read from local-folder-1 and write to Dropbox" — correct by the rule, and backwards for the
  // person reading it. That destination is what you copy FROM.
  const ui = read('src/ui/options.js');
  assert.match(ui, /copyTargets\.find\(\(s\) => s\.id !== archiveSinkId\)/, 'the default must skip the archive sink');
  assert.match(ui, /opt_copy_into_archive/, 'and choosing it anyway must be called out');
});

test('a destination with no name is described by its type, never by its raw id', () => {
  const ui = read('src/ui/options.js');
  assert.match(ui, /const destName = \(s\) => s\.name \|\| t\(SINK_TL\[s\.type\]\) \|\| s\.id/,
    '"local-folder-1" tells the user nothing');
  assert.ok(!/origins\.map\(\(s\) => s\.name \|\| s\.id\)/.test(ui), 'the origin list must use the same naming');
})
