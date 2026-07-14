import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netFetch } from '../src/runtime/inventory.js';

// Declarative throttle: consecutive calls to the SAME host are spaced by at least minMs (+ jitter). Uses
// unique hosts per test since the throttle clock is keyed per host at module scope.
test('netFetch throttle spaces calls to the same host by ~minMs', async () => {
  const times = [];
  const net = async () => { times.push(Date.now()); return { ok: true, status: 200 }; };
  const NET = netFetch(net, { minMs: 40, jitterMs: 0 });
  await NET('https://api.throttle-a.es/1'); // first call: no wait
  await NET('https://api.throttle-a.es/2'); // second: waits ~40ms
  const gap = times[1] - times[0];
  assert.ok(gap >= 35, 'expected ≥~40ms spacing, got ' + gap);
});

test('netFetch without throttle does not delay', async () => {
  const net = async () => ({ ok: true, status: 200 });
  const NET = netFetch(net); // no throttle config
  const t0 = Date.now();
  await NET('https://api.throttle-b.es/1');
  await NET('https://api.throttle-b.es/2');
  assert.ok(Date.now() - t0 < 30, 'unthrottled calls should be immediate');
});

test('jitter keeps the spacing at least minMs and adds up to jitterMs', async () => {
  const times = [];
  const net = async () => { times.push(Date.now()); return { ok: true, status: 200 }; };
  const NET = netFetch(net, { minMs: 30, jitterMs: 40 });
  await NET('https://api.throttle-c.es/1');
  await NET('https://api.throttle-c.es/2');
  const gap = times[1] - times[0];
  assert.ok(gap >= 25, 'gap below minMs: ' + gap);        // never faster than ~minMs
  assert.ok(gap <= 30 + 40 + 40, 'gap unreasonably large: ' + gap); // bounded by minMs+jitter (+ slop)
});
