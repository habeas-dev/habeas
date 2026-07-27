import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure scheduling policy for the background auto-sync runner — no chrome shim needed.
const { autoDebounced, retainAutoDebounce, autoBackoffMs, needsPageContext, orderedSweepSources, isLoginNavigation, needsTabEscalation, sweepSinkId, AUTO_DEBOUNCE_MS, AUTO_BACKOFF_BASE_MS, AUTO_BACKOFF_CAP_MS } = await import('../src/lib/autosync.js');

test('sweepSinkId: auto-route sink wins, then the source favorite, then the global default', () => {
  assert.equal(sweepSinkId('x', { x: 'auto' }, { x: 'fav' }, 'def'), 'auto');
  assert.equal(sweepSinkId('x', {}, { x: 'fav' }, 'def'), 'fav');
  assert.equal(sweepSinkId('x', {}, {}, 'def'), 'def');
  assert.equal(sweepSinkId('x', {}, {}, ''), '');
  assert.equal(sweepSinkId('x'), '');
});

test('needsTabEscalation: a session/challenge/auth failure escalates to a tab; success/hard-error do not', () => {
  assert.equal(needsTabEscalation({ status: 'done', new: 2 }), false);
  assert.equal(needsTabEscalation({ status: 'nosession' }), true);
  assert.equal(needsTabEscalation({ status: 'challenged' }), true);
  assert.equal(needsTabEscalation({ status: 'error', error: 'list 403 forbidden' }), true);
  assert.equal(needsTabEscalation({ status: 'error', error: 'csrf 400' }), true);
  assert.equal(needsTabEscalation({ status: 'error', error: 'no matching adapter' }), false);
  assert.equal(needsTabEscalation(null), false);
});

const wizink = { auth: { loginUrl: 'https://www.wizink.es/login' } };

test('isLoginNavigation: the login page is a pre-auth navigation → skip the auto-run there', () => {
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/login'), true);
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/login?error=1'), true);
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/login/otp'), true);
});

test('isLoginNavigation: the post-login data page is NOT the login page → run', () => {
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/clientes/posicion-global'), false);
  assert.equal(isLoginNavigation(wizink, 'https://www.wizink.es/loginx'), false); // not a path segment
});

test('isLoginNavigation: no loginUrl declared, or no url → never a login navigation', () => {
  assert.equal(isLoginNavigation({ auth: {} }, 'https://www.wizink.es/login'), false);
  assert.equal(isLoginNavigation(wizink, ''), false);
  assert.equal(isLoginNavigation(wizink, undefined), false);
});

test('autoDebounced: a route that never ran (or whose debounce was cleared) may run', () => {
  assert.equal(autoDebounced(undefined, 1_000), false);
  assert.equal(autoDebounced(null, 1_000), false);
});

test('autoDebounced: within the window it is held; past the window it is free', () => {
  const now = 10_000_000;
  assert.equal(autoDebounced(now - 1_000, now), true);
  assert.equal(autoDebounced(now - (AUTO_DEBOUNCE_MS - 1), now), true);
  assert.equal(autoDebounced(now - AUTO_DEBOUNCE_MS - 1, now), false);
});

test('retainAutoDebounce: a completed run (delivered or nothing-new) holds the 10-min debounce', () => {
  assert.equal(retainAutoDebounce('done'), true);
});

test('retainAutoDebounce: a transient/auth failure releases it so the next login retries at once', () => {
  // The auto-run can fire on the login page before the session exists (csrf/prelude 400), or hit an
  // anti-bot challenge, or find no captured session yet. None of these may burn the debounce, or the
  // retry after the user actually authenticates is suppressed for 10 minutes.
  for (const s of ['error', 'challenged', 'nosession']) {
    assert.equal(retainAutoDebounce(s), false, `status ${s} must release the debounce`);
  }
});

test('autoBackoffMs: first failure retries at once, then doubles, capped', () => {
  assert.equal(autoBackoffMs(0), 0);
  assert.equal(autoBackoffMs(1), 0, 'a first failure must not mute the source (a real login retries it)');
  assert.equal(autoBackoffMs(2), AUTO_BACKOFF_BASE_MS, '2nd failure → base cooldown');
  assert.equal(autoBackoffMs(3), AUTO_BACKOFF_BASE_MS * 2);
  assert.equal(autoBackoffMs(4), AUTO_BACKOFF_BASE_MS * 4);
  assert.equal(autoBackoffMs(50), AUTO_BACKOFF_CAP_MS, 'a persistent failure (ING 401 loop) tops out at the cap');
  assert.ok(autoBackoffMs(10) <= AUTO_BACKOFF_CAP_MS, 'never exceeds the cap');
});

test('needsPageContext: a cross-origin API (api.x ≠ site host) is page-only by default; same-host is not', () => {
  // ING: api.ing.ingdirect.es vs the site ing.ingdirect.es → cross-origin → needs the page context
  assert.equal(needsPageContext({ match: ['https://ing.ingdirect.es/*'], domain: 'ingdirect.es', api: { host: 'https://api.ing.ingdirect.es' } }), true);
  // Same host for site and API → a same-origin request → a SW fetch is fine
  assert.equal(needsPageContext({ match: ['https://www.x.com/*'], domain: 'x.com', api: { host: 'https://www.x.com' } }), false);
  // No hosts to compare → don't force page-only
  assert.equal(needsPageContext({ api: {} }), false);
});

test('needsPageContext: explicit flags override the cross-origin heuristic', () => {
  const crossOrigin = { match: ['https://www.carrefour.es/*'], domain: 'carrefour.es', api: { host: 'https://pro.api.carrefour.es' } };
  assert.equal(needsPageContext(crossOrigin), true, 'cross-origin default');
  assert.equal(needsPageContext({ ...crossOrigin, auth: { swFetchOk: true } }), false, 'swFetchOk opts a CORS-open API out');
  const sameHost = { match: ['https://x.com/*'], domain: 'x.com', api: { host: 'https://x.com' } };
  assert.equal(needsPageContext({ ...sameHost, auth: { pageOnly: true } }), true, 'pageOnly forces it on');
});

test('needsTabEscalation: a notab result escalates (open the site tab and retry in-page)', () => {
  assert.equal(needsTabEscalation({ status: 'notab' }), true);
  assert.equal(needsTabEscalation({ status: 'done' }), false);
});

test('orderedSweepSources: only opted-in enabled sources, ordered by sweepOrder then config position', () => {
  const ds = [
    { id: 'a', enabled: true, sweepOrder: 2 },
    { id: 'b', enabled: true, sweepOrder: 0 },
    { id: 'c', enabled: true },                 // no order → after the ordered ones
    { id: 'd', enabled: true, sweep: false },   // opted OUT → excluded
    { id: 'e', enabled: false, sweepOrder: 1 }, // disabled → excluded
    { id: 'f', enabled: true },                 // no order → keeps config position (after c)
  ];
  assert.deepEqual(orderedSweepSources(ds).map((d) => d.id), ['b', 'a', 'c', 'f']);
  assert.deepEqual(orderedSweepSources([]).map((d) => d.id), []);
  // default (no sweep field) = included
  assert.deepEqual(orderedSweepSources([{ id: 'x', enabled: true }]).map((d) => d.id), ['x']);
});
