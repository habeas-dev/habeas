// The background must stay awake for as long as an operation runs. Chrome recycles an idle service worker;
// Firefox suspends an idle event page. Both are held off the same way — by periodically calling an
// extension API — and if that call fails the whole operation dies mid-run with NO error: the status line
// keeps its last value ("Listing…"), nothing reaches the activity log, no notification fires. It looks
// exactly like a slow service.
//
// The heartbeat was written Chrome-style, `getPlatformInfo(() => {})`. lib/ext.js resolves `chrome` to
// `browser` on Firefox, and Firefox's browser.* APIs are promise-only: they VALIDATE their arguments and
// throw on an unexpected callback. Wrapped in try/catch, that made the heartbeat a silent no-op — on
// Firefox alone, which is why the same build kept working on Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHeartbeat, stopHeartbeat } from '../src/lib/keepalive.js';

// Firefox's browser.* namespace, as strict about arity as the real one.
function fakeFirefox() {
  const calls = { n: 0 };
  return { api: { runtime: { getPlatformInfo: (...args) => {
    if (args.length) throw new TypeError('Incorrect argument types for runtime.getPlatformInfo.');
    calls.n++; return Promise.resolve({ os: 'linux' });
  } } }, calls };
}
// Chrome MV3: promise-based too, but tolerant of the legacy callback.
function fakeChrome() {
  const calls = { n: 0 };
  return { api: { runtime: { getPlatformInfo: (cb) => { calls.n++; if (cb) { cb({ os: 'linux' }); return; } return Promise.resolve({ os: 'linux' }); } } }, calls };
}

const setup = (t) => { t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] }); t.after(() => stopHeartbeat()); };

test('the heartbeat actually beats on Firefox', (t) => {
  setup(t);
  const { api, calls } = fakeFirefox();
  startHeartbeat({ api, everyMs: 1000 });
  t.mock.timers.tick(3500);
  assert.equal(calls.n, 3, `Firefox must receive real heartbeats (got ${calls.n})`);
});

test('and on Chrome, unchanged', (t) => {
  setup(t);
  const { api, calls } = fakeChrome();
  startHeartbeat({ api, everyMs: 1000 });
  t.mock.timers.tick(3500);
  assert.equal(calls.n, 3, `Chrome must keep beating too (got ${calls.n})`);
});

test('stopping actually stops it — no timer outlives the operation', (t) => {
  setup(t);
  const { api, calls } = fakeFirefox();
  startHeartbeat({ api, everyMs: 1000 });
  t.mock.timers.tick(2500);
  stopHeartbeat();
  const after = calls.n;
  t.mock.timers.tick(5000);
  assert.equal(calls.n, after, 'no beat after stop');
});

test('a long operation is not cut off by a fixed lifetime cap', (t) => {
  // The old heartbeat stopped itself after six minutes on the theory that an op which forgot to stop
  // shouldn't beat forever. But a sweep across sixteen sources legitimately runs longer than that, and
  // the cap silently withdrew the very thing keeping it alive. A watchdog must be renewed by PROGRESS,
  // not expire on a wall clock.
  setup(t);
  const { api, calls } = fakeFirefox();
  startHeartbeat({ api, everyMs: 1000, idleMs: 5000 });
  t.mock.timers.tick(4000);
  startHeartbeat({ api, everyMs: 1000, idleMs: 5000 }); // progress → renew
  t.mock.timers.tick(4000);
  assert.equal(calls.n, 8, 'progress renews the heartbeat instead of letting it lapse');
});

test('it gives up only after a long silence, so a forgotten op cannot beat forever', (t) => {
  setup(t);
  const { api, calls } = fakeFirefox();
  startHeartbeat({ api, everyMs: 1000, idleMs: 5000 });
  t.mock.timers.tick(9000);
  const after = calls.n;
  // Beats up to the 5s deadline and stops there — 4 or 5 depending on whether the deadline or the beat
  // scheduled at the same instant runs first, which is not something worth pinning down.
  assert.ok(after >= 4 && after <= 5, `it beats up to the idle deadline and no further (got ${after})`);
  t.mock.timers.tick(9000);
  assert.equal(calls.n, after, 'a heartbeat nobody renews eventually stops on its own');
});
