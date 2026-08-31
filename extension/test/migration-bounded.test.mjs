// The tidy-up walks every source in the store, and on a cloud-backed store that is a request per month of
// history per source — minutes, not moments. Two things follow, and both were got wrong first time round.
//
// It must be BOUNDED: marking success only at the end means an interrupted pass starts over at the next
// start-up, and again after that — the same never-finishing loop already diagnosed in the startup recovery,
// reintroduced by making this pass heavy. And it must SAY SOMETHING: work with nothing on screen is
// indistinguishable from a hang, which is exactly how it was reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/lib/migrate.js', import.meta.url), 'utf8');
const BG = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

test('the attempt is claimed BEFORE the work, not marked after it', () => {
  const body = SRC.slice(SRC.indexOf('export async function runStoreMigration'));
  const claim = body.indexOf('claimOnce');
  const work = body.indexOf('renormalizeStore');
  assert.ok(claim >= 0, 'it must go through the bounded gate');
  assert.ok(claim < work, 'the attempt has to be recorded before the work, or an interruption is free');
  assert.ok(body.indexOf('settleOnce') > work, 'and settled after it');
});

test('an interrupted pass cannot retry for ever', () => {
  const body = SRC.slice(SRC.indexOf('export async function runStoreMigration'));
  assert.match(body, /maxTries:\s*3/, 'a fixed, small number of attempts');
  assert.match(body, /exhausted/, 'and giving up is reported, not silent');
});

test('every source it walks is announced', () => {
  const body = SRC.slice(SRC.indexOf('export async function retireSupersededDuplicates'));
  assert.match(body, /say\(/, 'progress must be emitted from inside the loop');
  assert.ok(body.indexOf('say(') < body.indexOf('loadSource'), 'announced BEFORE the slow read, not after it');
});

test('the background shows that progress and holds itself awake while it runs', () => {
  assert.match(BG, /runStoreMigration\(adapters, \{ onStatus/, 'the status has to reach the screen');
  const at = BG.indexOf('runStoreMigration(adapters, {');
  assert.ok(BG.lastIndexOf('keepAlive();', at) > 0, 'a heartbeat before a pass measured in minutes');
  assert.match(BG.slice(at, at + 600), /stopKeepAlive\(\)/, 'and released when it ends');
});

test('the status line is cleared when it finishes, leaving no stale message', () => {
  const body = SRC.slice(SRC.indexOf('export async function runStoreMigration'));
  assert.match(body, /finally\s*\{[^}]*say\(''\)/, "a status that outlives its work is its own kind of lie");
});
