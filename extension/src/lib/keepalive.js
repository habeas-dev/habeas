// Keep the background alive for as long as an operation is running.
//
// Chrome recycles an idle MV3 service worker; Firefox suspends an idle event page. Neither counts a
// pending `fetch` as activity, so a long listing or a long series of store reads can pass the idle
// threshold with nothing to show for it — and when the background goes, the operation goes with it:
// no error, no activity-log entry, no notification, the status line frozen on whatever it last said.
// A silent stall, which is the one failure nobody notices. Calling an extension API on a timer resets
// that idle timer in both browsers.
//
// It has to be written PROMISE-style. lib/ext.js resolves `chrome` to `browser` on Firefox, and
// Firefox's browser.* APIs validate their arguments: a Chrome-style trailing callback throws
// "Incorrect argument types", which a try/catch then swallows — leaving a heartbeat that never beat,
// on Firefox only. Same build, same code path, and Chrome none the wiser.
import { chrome as ext } from './ext.js';

const EVERY_MS = 20000;   // comfortably inside Chrome's 30s worker idle timeout and Firefox's event-page one
const IDLE_MS = 15 * 60 * 1000; // give up after this long with no renewal (a forgotten op must not beat forever)

let timer = null, expiry = null;

// Beat once. Promise-style, so it works on Firefox; a callback-style API (older Chrome) still returns
// undefined here, which is fine — the call itself is what resets the idle timer, not its result.
function beat(api) {
  try { const p = api.runtime.getPlatformInfo(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
  catch (e) { /* the call still counted as activity; nothing here depends on the answer */ }
}

// Start, or RENEW, the heartbeat. Every checkpoint of a long operation calls this, so the give-up
// deadline is pushed back by PROGRESS rather than expiring on a wall clock — a sweep across sixteen
// sources runs far longer than any fixed lifetime one would think to pick.
export function startHeartbeat(opts = {}) {
  const api = opts.api || ext;
  const everyMs = opts.everyMs || EVERY_MS;
  const idleMs = opts.idleMs || IDLE_MS;
  if (!api || !api.runtime || typeof api.runtime.getPlatformInfo !== 'function') return;
  clearTimeout(expiry);
  expiry = setTimeout(stopHeartbeat, idleMs);
  if (!timer) timer = setInterval(() => beat(api), everyMs);
}

export function stopHeartbeat() {
  if (timer) { clearInterval(timer); timer = null; }
  if (expiry) { clearTimeout(expiry); expiry = null; }
}
