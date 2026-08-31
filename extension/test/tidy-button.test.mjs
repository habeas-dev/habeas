// Clearing the duplicates was reachable only by clearing a storage key from a developer console, which is
// not a thing anyone can be asked to do — and there was no way back at all once the automatic attempts were
// spent. Settings → Advanced now has a button for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'cheerio';

const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const HTML = read('ui/options.html'), JS = read('ui/options.js'), BG = read('background.js'), MIG = read('lib/migrate.js');
const EN = JSON.parse(readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));
const ES = JSON.parse(readFileSync(new URL('../_locales/es/messages.json', import.meta.url), 'utf8'));

test('the button exists in Advanced, with a place to report the outcome', () => {
  const $ = load(HTML);
  const btn = $('#tidy-run');
  assert.equal(btn.length, 1, 'a button');
  assert.equal($('#tidy-run').closest('section').attr('data-sec'), 'advanced', 'in Advanced');
  assert.equal($('#tidy-status').length, 1, 'and somewhere to say what happened');
});

test('asking for it by hand ignores the once-only gate', () => {
  // Otherwise the button would do nothing for the very people who need it: those whose automatic attempts
  // were already spent, or for whom it had already run once and left duplicates behind.
  assert.match(MIG, /opts\.force \? \{ run: true/, 'a deliberate request is not rationed');
  assert.match(BG, /habeas:tidyArchive/, 'the background exposes it');
  assert.match(BG, /runStoreMigration\(adapters, \{ force: true/, 'and forces it');
});

test('it holds the extension awake and clears the status line afterwards', () => {
  const at = BG.indexOf("habeas:tidyArchive");
  const body = BG.slice(at, at + 900);
  assert.match(body, /keepAlive\(\)/, 'a pass measured in minutes must not be recycled halfway');
  assert.match(body, /finally \{ stopKeepAlive\(\); setStatus\(''\)/, 'and must leave no stale message behind');
});

test('the button reports what it did, including having found nothing', () => {
  assert.match(JS, /opt_tidy_running/, 'says it started');
  assert.match(JS, /opt_tidy_done/, 'says what it retired');
  assert.match(JS, /opt_tidy_none/, 'and says so when there was nothing — silence is not an answer');
  assert.match(JS, /opt_tidy_failed/, 'and reports a failure as a failure');
  assert.match(JS, /tidy\.disabled = true/, 'and cannot be started twice at once');
});

test('every string it shows exists in both languages', () => {
  for (const k of ['opt_tidy_title', 'opt_tidy_help', 'opt_tidy_btn', 'opt_tidy_running', 'opt_tidy_done', 'opt_tidy_none', 'opt_tidy_failed']) {
    assert.ok(EN[k], 'missing en: ' + k);
    assert.ok(ES[k], 'missing es: ' + k);
  }
});
