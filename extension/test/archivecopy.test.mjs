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

test('a copy touching a local folder at EITHER end runs page-side', () => {
  // Reported from real use: Dropbox → a new local folder appeared to run and wrote nothing. A folder is
  // reachable only through a directory handle and only a page can hold one, so the background's
  // writeToSink threw "no directory handle" for every chunk of every source — and the failures were
  // counted rather than shown, which is why it looked busy instead of broken. The page-side pass had been
  // built for the folder as ORIGIN and never for the folder as TARGET.
  const ui = read('src/ui/options.js');
  assert.match(ui, /const folderInvolved = target\.type === 'local-folder'/, 'a folder TARGET must run page-side');
  assert.match(ui, /s\.type === 'local-folder' && s\.id !== target\.id/, '…and so must a folder ORIGIN');
  assert.match(ui, /if \(!folderInvolved\) \{/, 'only a copy touching no folder may go to the background');
  const lib = read('src/lib/foldercopy.js');
  assert.match(lib, /dirHandle = await getHandle\('dir:' \+ target\.id\)/, 'the target handle must be resolved');
  assert.match(lib, /interactive: true, dirHandle/, 'and handed to writeToSink, which throws without it');
});

test('a failure is reported, not merely counted', () => {
  // "It is doing something but I do not know what" was the whole bug report. A copy that could not write
  // one single file read exactly like a copy with nothing left to do.
  const bg = read('src/background.js');
  assert.match(bg, /failed: failed\.length, firstError/, 'the run must report its failures');
  const ui = read('src/ui/options.js');
  assert.match(ui, /if \(r\.failed\)/, 'and the UI must show them');
  assert.match(ui, /opt_copy_nofolder/, 'a lapsed folder permission needs its own words, not "error"');
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
  // Its RECORD still travels — every writer emits the manifest alongside the files, and dropping the row
  // as well would lose the data too, for a document that does exist. What must never happen is reaching
  // for the service, which is the promise this operation makes.
  assert.match(src, /if \(!arts\.length\) skipped\+\+;\s*\n\s*else files\.set/,
    'a missing file is counted, and the record still goes');
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
  assert.match(bg.slice(i, bg.indexOf(';', i)), /s\.id !== sink\.id/, 'the background must exclude the target');

  const ui = read('src/ui/options.js');
  assert.match(ui, /s\.type === 'local-folder' && s\.id !== target\.id/, 'the page pass must exclude the target too');
  assert.match(ui, /const same = !!\(src && target && src\.id === target\.id\)/, 'and the user must be told when they collide');
});

test('the user is told what the copy will read from, not only where it writes', () => {
  // The origins are not chosen — each file comes from whichever destination happens to hold it — so
  // without this the user approves an operation without being told what it touches.
  const ui = read('src/ui/options.js');
  assert.match(ui, /describeCopy/, 'no origin/destination description');
  assert.match(ui, /opt_copy_pair/, 'the description must name both ends');
  assert.match(ui, /copySrc\.onchange = copySel\.onchange = describeCopy/, 'it must follow BOTH pickers');
  for (const lang of ['en', 'es']) {
    const msg = JSON.parse(read(`_locales/${lang}/messages.json`));
    for (const k of ['opt_copy_pair', 'opt_copy_noorigin', 'opt_copy_same', 'opt_copy_any_src']) {
      assert.ok(msg[k], `${lang} is missing ${k}`);
    }
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
  assert.match(ui, /copySrc\.value = archiveSinkId/, 'the ORIGIN should default to where the archive lives');
  assert.match(ui, /copyTargets\.find\(\(s\) => s\.id !== \(copySrc\.value \|\| archiveSinkId\)\)/,
    'and the destination must default to something else');
  assert.match(ui, /opt_copy_into_archive/, 'and choosing it anyway must be called out');
});

test('an unnamed local folder is named by its folder, not by its internal id', () => {
  // "local-folder-1" says nothing about WHICH folder, and that is the one destination whose identity
  // lives outside the extension. The File System Access API exposes no path — deliberately, since that
  // would reveal the disk's layout — but it does give the directory's own name, already stored as
  // folderName on creation and on every reconnect. It simply was not being read.
  const lbl = read('src/lib/sinklabel.js');
  assert.match(lbl, /sink\.type === 'local-folder' && sink\.folderName/, 'folderName must be preferred');
  assert.match(lbl, /sink_local_named/, 'and shown as "Folder <name>", so it says what it is as well as which');
  assert.match(lbl, /if \(sink\.name\) return sink\.name/, 'a name the user gave must still win');
  for (const lang of ['en', 'es']) {
    assert.ok(JSON.parse(read(`_locales/${lang}/messages.json`)).sink_local_named, `${lang} lacks sink_local_named`);
  }
});

test('every place that shows a destination name uses the one helper', () => {
  // Three copies of this had drifted across popup, archive and settings, so an unnamed folder read
  // differently depending on which screen you were on.
  for (const f of ['src/ui/options.js', 'src/ui/archive.js', 'src/ui/popup.js']) {
    const src = read(f);
    assert.match(src, /import \{ sinkLabel \} from '\.\.\/lib\/sinklabel\.js'/, `${f} must import it`);
    assert.ok(!/\bs\.name \|\| s\.id\b/.test(src), `${f} still builds a destination name by hand`);
  }
})

test('a pinned origin is honoured by BOTH passes, not just the background', () => {
  // Naming Dropbox as the origin must not quietly pull from a local folder as well — that would undo
  // the whole point of having chosen one.
  const bg = read('src/background.js');
  assert.match(bg, /!opts\.originId \|\| s\.id === opts\.originId/, 'the sender must respect a pinned origin');
  assert.match(bg, /originId: msg\.from \|\| ''/, 'and the message must carry it');
  const ui = read('src/ui/options.js');
  assert.match(ui, /&& \(!originId \|\| s\.id === originId\)/, 'the page-side folder pass must respect it too');
});

// ---------------------------------------------------------------- where a document actually lives

test('the detail names every destination a document is saved in', () => {
  // The card carried this only in a tooltip, and the drawer showed it implicitly as one "open from X"
  // button per destination — which answers nothing for a record-only movement, the case where the
  // question is hardest: a bank line has no file to open, so no part of the screen said where its data
  // had gone. Listed for a single destination too; "where is this?" has a one-item answer as often as not.
  const ui = read('src/ui/archive.js');
  const i = ui.indexOf('function openDrawer');
  assert.ok(i > 0, 'openDrawer not found');
  const body = ui.slice(i, ui.indexOf('\nfunction ', i + 10));
  assert.match(body, /archive_field_destinations/, 'the drawer must state where the document is saved');
  assert.match(body, /r\.delivered\.map\(sinkLabel\)/, 'named with the shared label helper, not by raw id');
  // Before the files row: where it lives, then what is there.
  assert.ok(body.indexOf('archive_field_destinations') < body.indexOf('archive_field_files'),
    'destinations should read before formats');
  for (const lang of ['en', 'es']) {
    assert.ok(JSON.parse(read(`_locales/${lang}/messages.json`)).archive_field_destinations, `${lang} lacks the label`);
  }
});

// ---------------------------------------------------------------- a folder destination on Firefox

test('a folder destination is offered nowhere on a browser that cannot open one', () => {
  // Configuration syncs between browsers, so a folder created in Chrome arrives in Firefox intact — where
  // File System Access does not exist. Settings hid the option to CREATE one and stopped there, so the
  // synced entry looked completely ordinary: listed, offered as a copy origin and target, and failing only
  // at the moment of use.
  const ui = read('src/ui/options.js');
  assert.match(ui, /KEEPS_FILES\.includes\(s\.type\) && !sinkUnavailableHere\(s\)/, 'not offered as a target');
  assert.match(ui, /RETRIEVABLE\.has\(s\.type\) && !sinkUnavailableHere\(s\)/, 'nor as an origin');
  assert.match(read('src/ui/popup.js'), /!sinkUnavailableHere\(s\)/, 'nor for a manual send');
});

test('…but it is KEPT and labelled, never deleted', () => {
  // Deleting it would be the tidy-looking mistake: configuration sync adopts and never prunes, so removing
  // the entry here would remove it from Chrome as well — losing a working destination to clean up a
  // cosmetic problem on the other machine.
  const lib = read('src/lib/folderavail.js');
  assert.match(lib, /sink\.type === 'local-folder' && !folderSinksUsable\(\)/);
  // It must only ANSWER the question, never act on it: no config, no storage, no imports at all.
  assert.ok(!/^import /m.test(lib), 'a pure predicate needs nothing');
  assert.ok(!/saveConfig|upsert\(|remove\(|chrome\./.test(lib), 'it must not touch configuration');
  const ui = read('src/ui/options.js');
  assert.match(ui, /dest_unavailable/, 'the card must say why it cannot be used here');
  for (const lang of ['en', 'es']) {
    const msg = JSON.parse(read(`_locales/${lang}/messages.json`));
    assert.ok(msg.dest_unavailable && msg.dest_unavailable_hint, `${lang} lacks the unavailable labels`);
  }
});

test('progress is reported per document, not per flushed batch', () => {
  // Reported from real use: "Copying to Folder …" and nothing further, no files. Reporting only on flush
  // meant nothing moved for the first 25 documents — each of which costs a round-trip to the origin — and
  // nothing moved AT ALL for an archive of record-only movements, where no batch ever fills because there
  // is no file to put in one. Silent and stuck look identical from the outside.
  const lib = read('src/lib/foldercopy.js');
  const i = lib.indexOf('for (const d of withFiles) {');
  const body = lib.slice(i, lib.indexOf('await flush();', i));
  assert.match(body, /onStatus\(\{ phase: 'copying', done: \+\+seen, total: withFiles\.length/, 'each document must report');
  // …and each SOURCE must report before it is read: a source with nothing outstanding produces no
  // document events at all, so with two dozen of them the screen sits still for minutes.
  assert.match(lib, /onStatus\(\{ phase: 'reading', source/, 'each source must report before reading');
  assert.ok(!/onStatus\(\{ sending:/.test(lib), 'the per-batch-only report must be gone');
});

test('a run that skipped everything does not claim the destination already had it', () => {
  const ui = read('src/ui/options.js');
  assert.match(ui, /!sent && skipped/, 'all-skipped needs its own message');
  assert.ok(ui.indexOf("t('opt_copy_allskipped'") < ui.indexOf("t('opt_copy_none'"),
    'the truthful case must be tested before the reassuring one');
  for (const lang of ['en', 'es']) {
    assert.ok(JSON.parse(read(`_locales/${lang}/messages.json`)).opt_copy_allskipped, `${lang} lacks it`);
  }
});

test('when nothing is found, the copy shows where it looked', () => {
  // "Zero bytes written" is unanswerable on its own: a document with no file and a document whose file is
  // filed under a path the retrieval does not reconstruct look exactly the same from here. Only one of
  // those is a bug. retrieveDelivered already reports the paths it tried; throwing them away was the
  // reason three rounds of this went undiagnosed.
  const lib = read('src/lib/foldercopy.js');
  assert.match(lib, /Array\.isArray\(r\.tried\) && r\.tried\.length/, 'the attempted paths must be kept');
  assert.match(lib, /misses\.length < 5/, 'a handful is enough — this is a diagnosis, not a log');
  assert.match(lib, /return \{ sent, found, skipped, misses/, 'and returned to the caller');
  const ui = read('src/ui/options.js');
  assert.match(ui, /if \(!sent && f\.misses && f\.misses\.length\)/, 'shown only when nothing came across');
  assert.match(ui, /opt_copy_looked/);
});

test('folders are created by writing a file, never as empty scaffolding', () => {
  // Asked directly, and the answer is no: the local-folder writer builds the path it needs on the way to
  // putting a file in it. Creating structure for documents that have no file would be inventing shape
  // where there is no content.
  const sinks = read('src/sinks/sinks.js');
  const i = sinks.indexOf("async ['local-folder']");
  const body = sinks.slice(i, sinks.indexOf('\n  },', i));
  assert.match(body, /for \(const art of files\.get\(d\.internalId\) \|\| \[\]\)[\s\S]*?ensureDir/,
    'the directory is made inside the per-artifact loop, so no artifact means no directory');
});

test('the copy asks what a document HAS before going to look for it', () => {
  // Asked directly: does Habeas not already know whether an entry has a file? It does. getDocMeta records
  // each document's formats at delivery time and again on the Archive's format scan, and the Archive, the
  // popup and the viewer all read it. The copy did not, so it rediscovered by request what was already
  // written down — one round-trip per document per candidate format, to be told a bank movement has no
  // file. That is where the five silent minutes went.
  const lib = read('src/lib/foldercopy.js');
  assert.match(lib, /getDocMeta\(storeIdOf\(ds, adapter\)\)/, 'the recorded formats must be read');
  assert.match(lib, /const withFiles = recordsOnly \? \[\] : docs\.filter\(\(d\) => !hasNoFile\(d\)\)/,
    'documents without files must be partitioned out BEFORE the loop, not visited to be skipped');
  // …and their RECORDS must still travel. Every writer emits the manifest alongside the files, so a
  // stream that declares no artifact — a bank's movements — still has data to copy. Skipping it would
  // leave a bank archive uncopied, which is most of what people have.
  assert.match(lib, /const recordOnlyDocs = recordsOnly \? docs : docs\.filter\(hasNoFile\)/,
    'records with no file must still be delivered');
  assert.ok(!/if \(!withFiles\.length\) \{\s*\n\s*skipped \+= docs\.length/.test(lib),
    'a stream with no artifacts must not be skipped outright');
  assert.match(lib, /total: withFiles\.length/, 'and the counter must count what will be copied, not what exists');
  assert.match(lib, /if \(wanted && !wanted\.has\(String\(k\.ext\)\.toLowerCase\(\)\)\) continue;/,
    'and a known format list must not be probed beyond');
  // artifactKinds yields {kind, ext} objects. Passing one where an extension belongs put "[object Object]"
  // into every reconstructed path and made the `only` filter compare an object against a string, so no
  // file could ever be found — which is what wrote zero bytes, whatever the archive held.
  assert.match(lib, /retrieveDelivered\(from, adapter, rec, k\.ext, \{ only: true \}\)/,
    'the artifact EXTENSION must be passed, never the artifact object');
  assert.match(lib, /const streamKinds = /,
    'a stream that declares no file at all must be settled without touching its documents');
  // Absent knowledge is different from knowing there is nothing: only then may it look.
  assert.match(lib, /Array\.isArray\(ex\) && ex\.length \? new Set/, 'probing stays the fallback for the unknown');
});
