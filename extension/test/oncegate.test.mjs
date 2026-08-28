// "Run this once, unattended, at start-up" is only safe if failure is bounded. The startup recovery
// recorded that it had finished only on reaching the end, so anything that stopped it first — an error, or
// the background being suspended underneath it — meant it ran again on the next start-up, and again, and
// again. Each attempt re-reads every source's manifest from every cloud destination. A pass that can never
// finish therefore becomes a permanent background load that looks, from outside, like a service being slow.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LOCAL = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => (k == null ? { ...LOCAL } : { [k]: LOCAL[k] }),
  set: async (o) => { Object.assign(LOCAL, o); },
  remove: async (k) => { delete LOCAL[k]; },
} } };

const { claimOnce, settleOnce } = await import('../src/lib/oncegate.js');
const reset = () => { for (const k of Object.keys(LOCAL)) delete LOCAL[k]; };
const KEY = 'habeas:automaint';

test('it runs, and once it succeeds it never runs again', async () => {
  reset();
  assert.equal((await claimOnce(KEY, 1)).run, true);
  await settleOnce(KEY, 1, true);
  assert.equal((await claimOnce(KEY, 1)).run, false, 'a completed task must not run again');
});

test('a task that keeps dying is retried — but not forever', async () => {
  reset();
  const tries = [];
  for (let i = 0; i < 6; i++) {
    const c = await claimOnce(KEY, 1, { maxTries: 3 });
    tries.push(c.run);
    if (c.run) await settleOnce(KEY, 1, false); // died / errored
  }
  assert.deepEqual(tries, [true, true, true, false, false, false],
    'three attempts, then it stops asking');
});

test('a start-up that is killed before settling still counts as an attempt', async () => {
  reset();
  // claimOnce must record the attempt BEFORE the work, or a task killed mid-run looks like it never
  // started and retries unboundedly — which is the exact failure being fixed.
  await claimOnce(KEY, 1, { maxTries: 2 });
  await claimOnce(KEY, 1, { maxTries: 2 });
  assert.equal((await claimOnce(KEY, 1, { maxTries: 2 })).run, false,
    'attempts must be counted at claim time, not at completion');
});

test('the last attempt says so, so giving up can be reported rather than silent', async () => {
  reset();
  await claimOnce(KEY, 1, { maxTries: 2 });
  const last = await claimOnce(KEY, 1, { maxTries: 2 });
  assert.equal(last.run, true);
  assert.equal(last.lastAttempt, true, 'the caller can log "this is the final try"');
});

test('a new version starts the count again — a fixed task deserves a fresh chance', async () => {
  reset();
  for (let i = 0; i < 4; i++) { const c = await claimOnce(KEY, 1, { maxTries: 2 }); if (c.run) await settleOnce(KEY, 1, false); }
  assert.equal((await claimOnce(KEY, 1, { maxTries: 2 })).run, false, 'version 1 has given up');
  assert.equal((await claimOnce(KEY, 2, { maxTries: 2 })).run, true, 'version 2 tries afresh');
});

test('the older bare-number marker still counts as done', async () => {
  // Before this gate the marker was just the version number. Anyone whose recovery had already completed
  // must not be made to run it again — on a large cloud archive that is a lot of re-reading for nothing.
  reset();
  LOCAL[KEY] = 1;
  assert.equal((await claimOnce(KEY, 1)).run, false, 'a completed legacy marker means done');
  assert.equal((await claimOnce(KEY, 2)).run, true, 'but a newer version still runs');
});
