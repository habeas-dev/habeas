// Tag every request Habeas makes, so it can be told apart from the site's own traffic in a proxy log.
//
// Pair it with `tools/mitm-habeas.py`, which is what makes the header safe to use: the addon flags the
// flow, STRIPS the header before forwarding, and answers the CORS preflight for it. So the tag reaches
// your proxy and nothing else.
//
// OFF BY DEFAULT, because without the addon it has two real costs:
//
//  1. It can break the source it is meant to debug. Habeas replays the SPA's own custom headers, so a
//     cross-origin call already goes through a CORS preflight; adding one more header means the server
//     must list it in `Access-Control-Allow-Headers` too. A strict endpoint starts failing the moment
//     this is switched on — which looks exactly like the bug being chased.
//  2. It makes Habeas identifiable TO THE SERVICE. The whole point of running inside the user's own
//     session is that the traffic is the user's traffic; a marker the service can read gives that away.
//
// Without the addon: `~hq "X-Habeas-Debug"` still filters to Habeas's requests. With it: `~c habeas`,
// and failures are marked so they cannot be scrolled past. The value carries the source id and a
// per-run counter, so a single sweep can be followed request by request.
import { chrome } from './ext.js';

const KEY = 'habeas:debugMark';
export const HEADER = 'X-Habeas-Debug';

let cached = null; // avoids a storage read per request; invalidated by setDebugMark and by the listener below

export async function debugMarkEnabled() {
  if (cached !== null) return cached;
  try {
    const o = await chrome.storage.local.get(KEY);
    cached = !!(o[KEY] && o[KEY].on);
  } catch (e) { cached = false; }
  return cached;
}

export async function setDebugMark(on) {
  cached = !!on;
  try { await chrome.storage.local.set({ [KEY]: { on: !!on, at: new Date().toISOString() } }); } catch (e) {}
}

// Another context (the options page) may flip it while a run is in flight.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cached = !!(changes[KEY].newValue && changes[KEY].newValue.on);
  });
} catch (e) { /* no storage events in this context — the cache just lives until reload */ }

let seq = 0;
/** Per-request tag: which source, and which request within this run. */
export function nextTag(sourceId) {
  seq += 1;
  return `${sourceId || 'habeas'}/${seq}`;
}

/**
 * Add the marker to a fetch init, without disturbing anything already there.
 * Returns the init unchanged when the toggle is off, so the request stays byte-identical to what the
 * site's own SPA would send.
 */
export function markInit(init, sourceId) {
  const out = { ...(init || {}) };
  const h = new Headers(out.headers || {});
  h.set(HEADER, nextTag(sourceId));
  out.headers = h;
  return out;
}

/** Wrap a fetch-like function so every call it makes carries the marker while the toggle is on. */
export function withDebugMark(fn, sourceId) {
  return async (url, init) => {
    if (!(await debugMarkEnabled())) return fn(url, init);
    return fn(url, markInit(init, sourceId));
  };
}
