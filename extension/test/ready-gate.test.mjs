// Trade Republic only has data to give once you are actually on your portfolio board — the URL carries a
// per-session id (…/boards/<id>). Reached from any other screen, the attempt is worthless at best and
// disturbs a freshly-opened session at worst, so it should not be made at all.
//
// `auth.readyUrl` already existed, but it only gated the run triggered BY a navigation. A sweep, or a
// manual run, went ahead through whatever tab happened to be open on the site — the login screen included.
//
// Making that gate strict for every source that declares one would change four sources that work today
// (ING, WiZink, IKEA, Revolut list fine from other screens). So the strict form is opt-in: `auth.readyStrict`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyGateBlocks, isReadyNavigation } from '../src/lib/autosync.js';

const TR = { id: 'tr', auth: { readyUrl: 'https://app.traderepublic.com/boards', readyStrict: true } };
const LOOSE = { id: 'wz', auth: { readyUrl: 'https://www.wizink.es/clientes/posicion-global' } }; // as today
const NONE = { id: 'x', auth: {} };

test('the board page, with its per-session id, counts as ready', () => {
  assert.equal(readyGateBlocks(TR, 'https://app.traderepublic.com/boards/9f2c1a7e-not-a-real-id'), false);
  assert.equal(readyGateBlocks(TR, 'https://app.traderepublic.com/boards'), false);
});

test('any other screen on the same site does not', () => {
  for (const u of [
    'https://app.traderepublic.com/login',
    'https://app.traderepublic.com/',
    'https://app.traderepublic.com/profile/settings',
  ]) assert.equal(readyGateBlocks(TR, u), true, 'must not attempt from ' + u);
});

test('no tab at all is blocked too — that is the point of "do not try"', () => {
  assert.equal(readyGateBlocks(TR, ''), true);
  assert.equal(readyGateBlocks(TR, null), true);
  assert.equal(readyGateBlocks(TR, undefined), true);
});

test('a source that declares readyUrl WITHOUT asking for strictness is unaffected', () => {
  // The four sources that already declare one keep listing from wherever they list from today.
  assert.equal(readyGateBlocks(LOOSE, 'https://www.wizink.es/clientes/movimientos'), false);
  assert.equal(readyGateBlocks(LOOSE, ''), false);
});

test('a source with no gate at all is never blocked', () => {
  assert.equal(readyGateBlocks(NONE, 'https://anything.test/x'), false);
  assert.equal(readyGateBlocks(NONE, ''), false);
  assert.equal(readyGateBlocks(null, ''), false);
});

test('the navigation gate keeps its own, looser meaning', () => {
  // isReadyNavigation answers "did the user just navigate to the data view?" and is used to decide whether
  // a navigation should TRIGGER a run. readyGateBlocks answers "is the run allowed to proceed at all?".
  // They must not be conflated: the first has always applied to every source declaring readyUrl.
  assert.equal(isReadyNavigation(LOOSE, 'https://www.wizink.es/clientes/posicion-global'), true);
  assert.equal(isReadyNavigation(LOOSE, 'https://www.wizink.es/clientes/movimientos'), false);
});

// ---------------------------------------------------------------- wiring

test('Trade Republic declares the gate, on the board page', async () => {
  const { readFileSync } = await import('node:fs');
  const src = JSON.parse(readFileSync(new URL('../../sources-repo/sources/traderepublic.json', import.meta.url), 'utf8'));
  assert.equal(src.auth.readyStrict, true);
  assert.equal(readyGateBlocks(src, 'https://app.traderepublic.com/boards/abc-123'), false, 'the board is ready');
  assert.equal(readyGateBlocks(src, 'https://app.traderepublic.com/login'), true, 'the login screen is not');
  assert.ok(src.minVersion >= '0.10.6', 'gated to the build that understands readyStrict, or older installs ignore it');
});

test('the run is refused softly, and the sweep does not try to fix it by opening a tab', async () => {
  const { readFileSync } = await import('node:fs');
  const bg = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(bg, /readyGateBlocks\(adapter, net && net\.url\)/, 'gated on the tab the run would actually use');
  assert.match(bg, /status: 'notready'/, 'a soft status, not an error');
  const { needsTabEscalation } = await import('../src/lib/autosync.js');
  assert.equal(needsTabEscalation({ status: 'notready' }), false,
    'opening a tab cannot help — only the user can navigate to their own board');
});
