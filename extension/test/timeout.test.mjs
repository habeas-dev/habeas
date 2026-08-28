// A request that never resolves is worse than one that fails: the run sits on "Listing…" forever, nothing
// is logged, no notification fires, and a source can go days producing nothing while looking busy — which
// is exactly what happened (four days of an apparently-running sync, no warning of any kind). Every call
// in a run must therefore be BOUNDED, and the failure must be a real, reported error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline, timedFetch, TimeoutError, DEFAULT_TIMEOUT_MS } from '../src/lib/timeout.js';

const never = () => new Promise(() => {});

test('a promise that never settles fails with a named timeout instead of hanging', async () => {
  await assert.rejects(() => withDeadline(never(), 20, 'listing'), (e) => {
    assert.ok(e instanceof TimeoutError, 'a distinguishable error type');
    assert.match(e.message, /listing/, 'the message must say WHAT timed out');
    assert.match(e.message, /timed out/i);
    return true;
  });
});

test('a promise that settles in time is untouched, and the timer does not hold the process', async () => {
  assert.equal(await withDeadline(Promise.resolve('ok'), 1000, 'x'), 'ok');
  await assert.rejects(() => withDeadline(Promise.reject(new Error('boom')), 1000, 'x'), /boom/);
});

test('timedFetch aborts the underlying request, so the connection is not left open', async () => {
  let seenSignal = null;
  const inner = (url, init) => { seenSignal = init.signal; return never(); };
  await assert.rejects(() => timedFetch(inner, 20, 'document')(('https://example.invalid/f')), TimeoutError);
  assert.ok(seenSignal, 'the inner fetch must receive a signal');
  assert.equal(seenSignal.aborted, true, 'and it must be aborted when the deadline passes');
});

test("timedFetch honours the caller's own signal (Stop) as well as the deadline", async () => {
  const outer = new AbortController();
  let seenSignal = null;
  const inner = (url, init) => { seenSignal = init.signal; return never(); };
  const p = timedFetch(inner, 5000, 'listing')('https://example.invalid/f', { signal: outer.signal });
  outer.abort();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(seenSignal.aborted, true, 'Stop must still abort immediately, not wait for the deadline');
  p.catch(() => {});
});

test('the default deadline is generous enough for a slow document but short of forever', () => {
  assert.ok(DEFAULT_TIMEOUT_MS >= 30000 && DEFAULT_TIMEOUT_MS <= 180000, 'between 30s and 3min');
});
