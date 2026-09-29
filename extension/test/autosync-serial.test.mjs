import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialized } from '../src/lib/autosync.js';

// Two triggers for one login (the navigation AND the captured session) used to enter runAutoRoutes together.
// Its "already running?" check sits several awaits before the route is marked as running, so both passed it
// and the same route ran twice in parallel — every WiZink request went out in pairs (measured 2026-09-29).
test('serialized: a second call waits for the first to finish before it starts', async () => {
  const events = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const fn = serialized(async (name) => { events.push('start ' + name); if (name === 'a') await gate; events.push('end ' + name); });
  const pa = fn('a'), pb = fn('b');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ['start a'], 'b must not start while a is still checking');
  release();
  await Promise.all([pa, pb]);
  assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b']);
});

test('serialized: a failing call does not block the next one', async () => {
  const fn = serialized(async (x) => { if (x === 'boom') throw new Error('boom'); return x; });
  await assert.rejects(fn('boom'), /boom/);
  assert.equal(await fn('ok'), 'ok');
});
