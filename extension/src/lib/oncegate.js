// "Do this once, unattended, at start-up" — with a bound on failure.
//
// The naive version records completion at the end and nothing at the start, so a task that never reaches
// its end is indistinguishable from one that never began: it runs again on the next start-up, and every
// start-up after that. For a pass that re-reads every source's manifest from every cloud destination, that
// is not a wasted retry, it is a permanent background load — and one that looks from the outside like the
// service being slow, since the traffic is all to the destination and none of it to the source.
//
// So the attempt is recorded BEFORE the work. A task that dies mid-run has still used a try.
import { chrome } from './ext.js';

const DEFAULT_MAX_TRIES = 3;

// Ask to run. Returns { run, tries, lastAttempt }. Records the attempt immediately.
export async function claimOnce(key, version, opts = {}) {
  const maxTries = opts.maxTries || DEFAULT_MAX_TRIES;
  let st = {};
  try { st = (await chrome.storage.local.get(key))[key] || {}; } catch (e) {}
  // The older marker was the bare version number. Honour it: someone whose task already completed must
  // not be made to repeat it just because the bookkeeping changed shape.
  if (typeof st !== 'object' || st === null) st = st === version ? { version, done: true, tries: 0 } : {};
  if (st.version === version && st.done) return { run: false, tries: st.tries || 0, lastAttempt: false };
  const tries = st.version === version ? (st.tries || 0) : 0; // a new version tries afresh
  if (tries >= maxTries) return { run: false, tries, lastAttempt: false };
  const next = { version, done: false, tries: tries + 1 };
  try { await chrome.storage.local.set({ [key]: next }); } catch (e) {}
  return { run: true, tries: next.tries, lastAttempt: next.tries >= maxTries };
}

// Report the outcome. `ok` marks it finished for good; a failure just leaves the attempt counted.
export async function settleOnce(key, version, ok) {
  if (!ok) return;
  try { await chrome.storage.local.set({ [key]: { version, done: true, tries: 0 } }); } catch (e) {}
}
